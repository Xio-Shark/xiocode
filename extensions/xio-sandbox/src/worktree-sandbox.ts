import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git, gitOk, gitWithEnv } from "./git.ts";

export type WorktreeSession = Readonly<{
  mainRoot: string;
  worktreePath: string;
  branch: string;
  sessionId: string;
  repoId: string;
  baseRef: string;
  /** Git tree of visible files at session start (no ignored). Dirty identity. */
  baselineTree: string;
}>;

export type WorktreeCreateOptions = Readonly<{
  mainRoot: string;
  sessionId?: string;
  baseDir?: string;
  baseRef?: string;
}>;

export type WorktreeConfig = Readonly<{
  enabled: boolean;
  retainOnReject: boolean;
  allowDirty: boolean;
}>;

export type TurnCheckpoint = Readonly<{
  head: string;
  tree: string;
}>;

export type DurableTurnCheckpoint = TurnCheckpoint & Readonly<{
  ref: string;
  commit: string;
}>;
export type WorktreeAttachOptions = Readonly<{
  baseDir?: string;
}>;
export const DEFAULT_WORKTREE_CONFIG: WorktreeConfig = {
  /** Opt-in outer worktree sandbox; default is main cwd (no worktree, git optional). */
  enabled: false,
  retainOnReject: false,
  allowDirty: false,
};

export class WorktreeSandbox {
  static repoId(mainRoot: string): string {
    return createHash("sha256").update(path.resolve(mainRoot)).digest("hex").slice(0, 16);
  }

  /** Git toplevel when cwd is inside a repo; undefined otherwise (no throw). */
  static async tryResolveMainRoot(cwd: string): Promise<string | undefined> {
    const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
    if (result.code !== 0) {
      return undefined;
    }
    const top = result.stdout.trim();
    return top.length > 0 ? path.resolve(top) : undefined;
  }

  /**
   * Git toplevel for worktree mode. Throws when not inside a git repo.
   * Prefer `tryResolveMainRoot` when git is optional (default main-cwd mode).
   */
  static async resolveMainRoot(cwd: string): Promise<string> {
    const top = await WorktreeSandbox.tryResolveMainRoot(cwd);
    if (!top) {
      throw new Error(
        "Worktree mode requires a git repository. Initialize with `git init` (and an initial commit), "
          + "or set `[worktree] enabled = false` to run in the current directory without a worktree.",
      );
    }
    return top;
  }

  static async create(options: WorktreeCreateOptions): Promise<WorktreeSession> {
    const mainRoot = path.resolve(options.mainRoot);
    await gitOk(mainRoot, ["rev-parse", "--is-inside-work-tree"]);

    const sessionId = options.sessionId ?? randomUUID().replaceAll("-", "").slice(0, 12);
    const repoId = WorktreeSandbox.repoId(mainRoot);
    const baseDir = options.baseDir ?? path.join(os.homedir(), ".xiocode", "worktrees");
    const worktreePath = path.join(baseDir, repoId, sessionId);
    const branch = `xio/${sessionId}`;
    const requestedBaseRef = options.baseRef ?? "HEAD";
    const baseRef = await gitOk(mainRoot, ["rev-parse", "--verify", `${requestedBaseRef}^{commit}`]);

    // Capture launch-time visible tree before worktree mutation; ignored files stay out.
    const baselineTree = await WorktreeSandbox.captureVisibleTree(mainRoot, baseRef);

    await mkdir(path.dirname(worktreePath), { recursive: true });
    const add = await git(mainRoot, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
    if (add.code !== 0) {
      throw new Error(`failed to create worktree: ${add.stderr || add.stdout}`);
    }

    await WorktreeSandbox.materializeBaselineTree(worktreePath, baselineTree, baseRef);

    return { mainRoot, worktreePath, branch, sessionId, repoId, baseRef, baselineTree };
  }

  /**
   * Capture the Git tree of user-visible files (tracked + untracked, no ignored).
   * Uses a temporary index so the live index / staging area is untouched.
   */
  static async captureVisibleTree(repoRoot: string, baseRef: string): Promise<string> {
    const root = path.resolve(repoRoot);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-visible-tree-"));
    const env = { GIT_INDEX_FILE: path.join(tempDir, "index") };
    try {
      await gitWithEnvOk(root, ["read-tree", baseRef], env);
      // No -f: ignored files must not enter the session baseline / merge delta.
      await gitWithEnvOk(root, ["add", "-A", "--", "."], env);
      return await gitWithEnvOk(root, ["write-tree"], env);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Write baseline contents into a worktree without forging a branch commit:
   * materialize tree, then mixed-reset so HEAD stays at baseRef.
   */
  static async materializeBaselineTree(
    worktreePath: string,
    baselineTree: string,
    baseRef: string,
  ): Promise<void> {
    await gitOk(worktreePath, ["cat-file", "-e", `${baselineTree}^{tree}`]);
    await gitOk(worktreePath, ["read-tree", "--reset", "-u", baselineTree]);
    await gitOk(worktreePath, ["reset", "--mixed", baseRef]);
  }

  /** True when baseline is not the clean baseRef tree (launch had visible WIP). */
  static async isDirtyBaseline(session: WorktreeSession): Promise<boolean> {
    const cleanTree = await gitOk(session.mainRoot, ["rev-parse", `${session.baseRef}^{tree}`]);
    return session.baselineTree !== cleanTree;
  }

  static async attach(input: WorktreeSession, options: WorktreeAttachOptions = {}): Promise<WorktreeSession> {
    const mainRoot = path.resolve(input.mainRoot);
    const worktreePath = path.resolve(input.worktreePath);
    const repoId = WorktreeSandbox.repoId(mainRoot);
    if (input.repoId !== repoId) {
      throw new Error(`worktree attach refused: repo id mismatch (${input.repoId} != ${repoId})`);
    }
    await WorktreeSandbox.assertExpectedWorktreePath({ ...input, mainRoot, worktreePath }, options.baseDir);
    await WorktreeSandbox.assertSameRepository(mainRoot, worktreePath);
    await WorktreeSandbox.assertRegisteredWorktree(mainRoot, worktreePath);
    const branch = await gitOk(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch !== input.branch) {
      throw new Error(`worktree attach refused: expected branch ${input.branch}, got ${branch}`);
    }
    await gitOk(worktreePath, ["rev-parse", "--verify", `${input.baseRef}^{commit}`]);

    // Old v2 sessions may omit baselineTree (empty string from resume); treat as clean baseRef tree.
    const baselineTree = input.baselineTree && input.baselineTree.length > 0
      ? input.baselineTree
      : await gitOk(mainRoot, ["rev-parse", `${input.baseRef}^{tree}`]);
    await gitOk(mainRoot, ["cat-file", "-e", `${baselineTree}^{tree}`]);

    return { ...input, mainRoot, worktreePath, repoId, baselineTree };
  }

  static async hasUncommittedChanges(session: WorktreeSession): Promise<boolean> {
    const status = await gitOk(session.worktreePath, ["status", "--porcelain"]);
    return status.trim().length > 0;
  }

  static async isMerged(session: WorktreeSession): Promise<boolean> {
    const result = await git(session.mainRoot, ["merge-base", "--is-ancestor", session.branch, "HEAD"]);
    return result.code === 0;
  }

  /**
   * True when agent produced changes beyond the launch baseline, or branch is ahead of main.
   * Launch WIP alone is not "unmerged agent work".
   */
  static async hasUnmergedChanges(session: WorktreeSession): Promise<boolean> {
    const currentTree = await WorktreeSandbox.captureVisibleTree(session.worktreePath, session.baseRef);
    if (currentTree !== session.baselineTree) {
      return true;
    }
    const ahead = await git(session.mainRoot, ["rev-list", "--count", `HEAD..${session.branch}`]);
    if (ahead.code !== 0) {
      return true;
    }
    return Number.parseInt(ahead.stdout.trim() || "0", 10) > 0;
  }

  static async rollbackToSessionBaseline(session: WorktreeSession): Promise<void> {
    await WorktreeSandbox.assertWorktreeRoot(session);
    await gitOk(session.worktreePath, ["rev-parse", "--verify", `${session.baseRef}^{commit}`]);
    await gitOk(session.worktreePath, ["cat-file", "-e", `${session.baselineTree}^{tree}`]);
    await gitOk(session.worktreePath, ["reset", "--hard", session.baseRef]);
    await gitOk(session.worktreePath, ["clean", "-ffdx"]);
    await WorktreeSandbox.materializeBaselineTree(
      session.worktreePath,
      session.baselineTree,
      session.baseRef,
    );
  }

  static async captureTurnCheckpoint(session: WorktreeSession): Promise<TurnCheckpoint> {
    await WorktreeSandbox.assertWorktreeRoot(session);
    const [head, tree] = await Promise.all([
      gitOk(session.worktreePath, ["rev-parse", "HEAD"]),
      WorktreeSandbox.writeWorktreeTree(session.worktreePath),
    ]);
    return { head, tree };
  }

  static async captureDurableCheckpoint(
    session: WorktreeSession,
    checkpointId = randomUUID().replaceAll("-", ""),
  ): Promise<DurableTurnCheckpoint> {
    await WorktreeSandbox.assertWorktreeRoot(session);
    assertRefComponent(checkpointId, "checkpoint id");
    assertRefComponent(session.sessionId, "session id");
    const [head, tree] = await Promise.all([
      gitOk(session.worktreePath, ["rev-parse", "HEAD"]),
      WorktreeSandbox.writeWorktreeTree(session.worktreePath),
    ]);
    const commit = await gitWithEnvOk(
      session.worktreePath,
      ["commit-tree", tree, "-p", head, "-m", `XioCode checkpoint ${checkpointId}`],
      checkpointIdentityEnv(),
    );
    const ref = `refs/xiocode/checkpoints/${session.sessionId}/${checkpointId}`;
    await gitOk(session.mainRoot, ["check-ref-format", ref]);
    await gitOk(session.mainRoot, ["update-ref", ref, commit]);
    return { head, tree, ref, commit };
  }

  static async releaseCheckpoint(session: WorktreeSession, checkpoint: DurableTurnCheckpoint): Promise<void> {
    const prefix = `refs/xiocode/checkpoints/${session.sessionId}/`;
    if (!checkpoint.ref.startsWith(prefix)) {
      throw new Error(`checkpoint release refused: ref is outside session namespace: ${checkpoint.ref}`);
    }
    const current = await git(session.mainRoot, ["rev-parse", "--verify", checkpoint.ref]);
    if (current.code !== 0) return;
    if (current.stdout !== checkpoint.commit) {
      throw new Error(`checkpoint release refused: ref ${checkpoint.ref} no longer points to ${checkpoint.commit}`);
    }
    await gitOk(session.mainRoot, ["update-ref", "-d", checkpoint.ref, checkpoint.commit]);
  }

  static async releaseSessionCheckpoints(input: Readonly<{ mainRoot: string; sessionId: string }>): Promise<void> {
    assertRefComponent(input.sessionId, "session id");
    const prefix = `refs/xiocode/checkpoints/${input.sessionId}/`;
    const refs = await gitOk(input.mainRoot, ["for-each-ref", "--format=%(refname)", prefix]);
    for (const ref of refs.split("\n").filter(Boolean)) {
      if (!ref.startsWith(prefix)) {
        throw new Error(`checkpoint cleanup refused: ref is outside session namespace: ${ref}`);
      }
      await gitOk(input.mainRoot, ["update-ref", "-d", ref]);
    }
  }

  static async validateCheckpoint(session: WorktreeSession, checkpoint: DurableTurnCheckpoint): Promise<void> {
    await WorktreeSandbox.assertWorktreeRoot(session);
    const prefix = `refs/xiocode/checkpoints/${session.sessionId}/`;
    if (!checkpoint.ref.startsWith(prefix)) {
      throw new Error(`checkpoint validation refused: ref is outside session namespace: ${checkpoint.ref}`);
    }
    const [refCommit, tree, head] = await Promise.all([
      gitOk(session.mainRoot, ["rev-parse", "--verify", checkpoint.ref]),
      gitOk(session.mainRoot, ["rev-parse", `${checkpoint.commit}^{tree}`]),
      gitOk(session.mainRoot, ["rev-parse", "--verify", `${checkpoint.head}^{commit}`]),
    ]);
    if (refCommit !== checkpoint.commit || tree !== checkpoint.tree || head !== checkpoint.head) {
      throw new Error(`checkpoint validation failed for ${checkpoint.ref}`);
    }
  }

  static async summarizeSinceCheckpoint(
    session: WorktreeSession,
    checkpoint: TurnCheckpoint,
  ): Promise<{ text: string; filesChanged: number; hasChanges: boolean }> {
    await WorktreeSandbox.assertWorktreeRoot(session);
    const currentTree = await WorktreeSandbox.writeWorktreeTree(session.worktreePath);
    const names = await gitOk(session.worktreePath, ["diff", "--name-only", checkpoint.tree, currentTree]);
    const files = names.split("\n").filter((line) => line.length > 0);
    if (files.length === 0) {
      return { text: "(no changes since turn start)", filesChanged: 0, hasChanges: false };
    }
    const stat = await gitOk(session.worktreePath, ["diff", "--stat", checkpoint.tree, currentTree]);
    return { text: stat, filesChanged: files.length, hasChanges: true };
  }

  /** Summarize agent delta vs launch baseline (visible trees only). */
  static async summarizeSinceBaseline(
    session: WorktreeSession,
  ): Promise<{ text: string; filesChanged: number; hasChanges: boolean }> {
    await WorktreeSandbox.assertWorktreeRoot(session);
    const currentTree = await WorktreeSandbox.captureVisibleTree(session.worktreePath, session.baseRef);
    const names = await gitOk(session.worktreePath, ["diff", "--name-only", session.baselineTree, currentTree]);
    const files = names.split("\n").filter((line) => line.length > 0);
    if (files.length === 0) {
      return { text: "(no changes relative to session baseline)", filesChanged: 0, hasChanges: false };
    }
    const unified = await gitOk(session.worktreePath, [
      "diff",
      "--no-ext-diff",
      session.baselineTree,
      currentTree,
    ]);
    return { text: unified, filesChanged: files.length, hasChanges: true };
  }

  static async rollbackToTurnCheckpoint(session: WorktreeSession, checkpoint: TurnCheckpoint): Promise<void> {
    await WorktreeSandbox.assertWorktreeRoot(session);
    await gitOk(session.worktreePath, ["cat-file", "-e", `${checkpoint.tree}^{tree}`]);
    await gitOk(session.worktreePath, ["reset", "--hard", checkpoint.head]);
    await gitOk(session.worktreePath, ["clean", "-ffdx"]);
    await gitOk(session.worktreePath, ["read-tree", "--reset", "-u", checkpoint.tree]);
    await gitOk(session.worktreePath, ["reset", "--mixed", checkpoint.head]);
  }

  static async remove(session: WorktreeSession, options: { force?: boolean } = {}): Promise<void> {
    const args = ["worktree", "remove"];
    if (options.force) {
      args.push("--force");
    }
    args.push(session.worktreePath);
    const remove = await git(session.mainRoot, args);
    if (remove.code !== 0) {
      const forceRemove = await git(session.mainRoot, ["worktree", "remove", "--force", session.worktreePath]);
      if (forceRemove.code !== 0) {
        throw new Error(`failed to remove worktree: ${forceRemove.stderr || remove.stderr}`);
      }
    }
    await git(session.mainRoot, ["branch", "-D", session.branch]);
  }

  private static async assertWorktreeRoot(session: WorktreeSession): Promise<void> {
    const root = await realpath(await gitOk(session.worktreePath, ["rev-parse", "--show-toplevel"]));
    const expectedRoot = await realpath(session.worktreePath);
    if (root !== expectedRoot) {
      throw new Error(`rollback refused: expected worktree root ${session.worktreePath}, got ${root}`);
    }
  }

  private static async assertExpectedWorktreePath(session: WorktreeSession, baseDir: string | undefined): Promise<void> {
    const expected = baseDir
      ? path.join(path.resolve(baseDir), session.repoId, session.sessionId)
      : path.join(path.dirname(path.dirname(session.worktreePath)), session.repoId, session.sessionId);
    const [expectedPath, actualPath] = await Promise.all([realpath(expected), realpath(session.worktreePath)]);
    if (expectedPath !== actualPath) {
      throw new Error(`worktree attach refused: expected path ${expectedPath}, got ${actualPath}`);
    }
  }

  private static async assertSameRepository(mainRoot: string, worktreePath: string): Promise<void> {
    const [mainCommonDir, worktreeCommonDir] = await Promise.all([
      resolveGitPath(mainRoot, await gitOk(mainRoot, ["rev-parse", "--git-common-dir"])),
      resolveGitPath(worktreePath, await gitOk(worktreePath, ["rev-parse", "--git-common-dir"])),
    ]);
    if (mainCommonDir !== worktreeCommonDir) {
      throw new Error(`worktree attach refused: git common directory mismatch`);
    }
  }

  private static async assertRegisteredWorktree(mainRoot: string, worktreePath: string): Promise<void> {
    const listing = await gitOk(mainRoot, ["worktree", "list", "--porcelain"]);
    const registered = await Promise.all(listing
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => realpath(path.resolve(line.slice("worktree ".length)))));
    if (!registered.includes(await realpath(worktreePath))) {
      throw new Error(`worktree attach refused: path is not registered with ${mainRoot}`);
    }
  }

  /**
   * Turn-checkpoint tree: includes ignored files (`-f`) so ignored artifacts can be restored.
   * Separate from visible baseline capture used for merge/summary.
   */
  private static async writeWorktreeTree(worktreePath: string): Promise<string> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-turn-checkpoint-"));
    const env = { GIT_INDEX_FILE: path.join(tempDir, "index") };
    try {
      await gitWithEnvOk(worktreePath, ["read-tree", "HEAD"], env);
      await gitWithEnvOk(worktreePath, ["add", "-A", "-f", "--", "."], env);
      return await gitWithEnvOk(worktreePath, ["write-tree"], env);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

async function resolveGitPath(cwd: string, value: string): Promise<string> {
  return realpath(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

function checkpointIdentityEnv(): Readonly<Record<string, string>> {
  return {
    GIT_AUTHOR_NAME: "XioCode Checkpoint",
    GIT_AUTHOR_EMAIL: "checkpoint@xiocode.local",
    GIT_COMMITTER_NAME: "XioCode Checkpoint",
    GIT_COMMITTER_EMAIL: "checkpoint@xiocode.local",
  };
}

function assertRefComponent(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} contains unsafe ref characters: ${value}`);
  }
}

async function gitWithEnvOk(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<string> {
  const result = await gitWithEnv(cwd, args, env);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}
