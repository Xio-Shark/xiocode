import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git, gitOk } from "./git.ts";

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
    const baseRef = options.baseRef ?? (await resolveHeadRef(mainRoot));

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
}

async function resolveHeadRef(mainRoot: string): Promise<string> {
  const symbolic = await git(mainRoot, ["symbolic-ref", "--short", "HEAD"]);
  if (symbolic.code === 0 && symbolic.stdout.trim().length > 0) {
    return symbolic.stdout.trim();
  }
  return gitOk(mainRoot, ["rev-parse", "HEAD"]);
}
