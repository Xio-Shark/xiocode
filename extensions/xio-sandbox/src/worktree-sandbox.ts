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
}>;

export type TurnCheckpoint = Readonly<{
  head: string;
  tree: string;
}>;

export const DEFAULT_WORKTREE_CONFIG: WorktreeConfig = {
  enabled: true,
  retainOnReject: false,
};

export class WorktreeSandbox {
  static repoId(mainRoot: string): string {
    return createHash("sha256").update(path.resolve(mainRoot)).digest("hex").slice(0, 16);
  }

  static async resolveMainRoot(cwd: string): Promise<string> {
    const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
    if (result.code !== 0) {
      throw new Error(
        "XioCode requires a git repository. Initialize with `git init` (and an initial commit) before starting.",
      );
    }
    return path.resolve(result.stdout.trim());
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

    await mkdir(path.dirname(worktreePath), { recursive: true });
    const add = await git(mainRoot, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
    if (add.code !== 0) {
      throw new Error(`failed to create worktree: ${add.stderr || add.stdout}`);
    }

    return { mainRoot, worktreePath, branch, sessionId, repoId, baseRef };
  }

  static async hasUncommittedChanges(session: WorktreeSession): Promise<boolean> {
    const status = await gitOk(session.worktreePath, ["status", "--porcelain"]);
    return status.trim().length > 0;
  }

  static async isMerged(session: WorktreeSession): Promise<boolean> {
    const result = await git(session.mainRoot, ["merge-base", "--is-ancestor", session.branch, "HEAD"]);
    return result.code === 0;
  }

  static async hasUnmergedChanges(session: WorktreeSession): Promise<boolean> {
    if (await WorktreeSandbox.hasUncommittedChanges(session)) {
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
    await gitOk(session.worktreePath, ["reset", "--hard", session.baseRef]);
    await gitOk(session.worktreePath, ["clean", "-ffdx"]);
  }

  static async captureTurnCheckpoint(session: WorktreeSession): Promise<TurnCheckpoint> {
    await WorktreeSandbox.assertWorktreeRoot(session);
    const [head, tree] = await Promise.all([
      gitOk(session.worktreePath, ["rev-parse", "HEAD"]),
      WorktreeSandbox.writeWorktreeTree(session.worktreePath),
    ]);
    return { head, tree };
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
