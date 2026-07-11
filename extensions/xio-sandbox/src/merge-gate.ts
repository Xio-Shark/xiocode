import { WorktreeSandbox } from "./worktree-sandbox.ts";

import { git, gitOk } from "./git.ts";

import type { TurnCheckpoint, WorktreeSession } from "./worktree-sandbox.ts";

export type DiffSummary = Readonly<{
  text: string;
  hasChanges: boolean;
  filesChanged: number;
  uncommitted: boolean;
}>;

export type MergeResult =
  | Readonly<{ ok: true; summary: string }>
  | Readonly<{ ok: false; error: string; conflict: boolean }>;

export type RollbackResult = Readonly<{
  ok: true;
  skipped: boolean;
  summary: string;
}>;

export type AskFn = (question: string) => Promise<boolean>;

export class MergeGate {
  readonly #session: WorktreeSession;
  #merged = false;
  #turnCheckpoint: TurnCheckpoint | undefined;

  constructor(session: WorktreeSession) {
    this.#session = session;
  }

  get session(): WorktreeSession {
    return this.#session;
  }

  get merged(): boolean {
    return this.#merged;
  }

  markMerged(): void {
    this.#merged = true;
  }

  async captureTurnCheckpoint(): Promise<void> {
    if (this.#merged) {
      throw new Error("cannot checkpoint after this session has been merged into the main tree");
    }
    this.#turnCheckpoint = await WorktreeSandbox.captureTurnCheckpoint(this.#session);
  }

  async summarize(options: { includeIgnored?: boolean } = {}): Promise<DiffSummary> {
    const range = `${this.#session.baseRef}...${this.#session.branch}`;
    const nameStatus = await git(this.#session.mainRoot, ["diff", "--name-status", range]);
    const unified = await git(this.#session.worktreePath, ["diff", "--no-ext-diff", this.#session.baseRef]);
    const statusArgs = ["status", "--short", "--untracked-files=all"];
    if (options.includeIgnored) statusArgs.push("--ignored=matching");
    const worktreeStatus = await git(this.#session.worktreePath, statusArgs);

    const committedFiles = nameStatus.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const uncommittedFiles = worktreeStatus.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const uncommitted = uncommittedFiles.some((line) => !line.startsWith("!!"));

    const filesChanged = new Set([
      ...committedFiles.map((line) => line.replace(/^[A-Z]+\s+/, "")),
      ...uncommittedFiles.map((line) => line.replace(/^..\s+/, "")),
    ]).size;

    const parts: string[] = [];
    if (unified.stdout.trim().length > 0) {
      parts.push(unified.stdout.trim());
    }
    if (worktreeStatus.stdout.trim().length > 0) {
      parts.push("Worktree status:");
      parts.push(worktreeStatus.stdout.trim());
    }
    if (parts.length === 0) {
      parts.push("(no changes relative to main tree)");
    }

    return {
      text: parts.join("\n"),
      hasChanges: filesChanged > 0 || uncommitted,
      filesChanged,
      uncommitted,
    };
  }

  async merge(): Promise<MergeResult> {
    if (this.#merged) {
      return { ok: true, summary: "already merged" };
    }

    try {
      await this.#commitWorktreeIfNeeded();
      const target = await currentBranchOrHead(this.#session.mainRoot);
      const ff = await git(this.#session.mainRoot, ["merge", "--ff-only", this.#session.branch]);
      if (ff.code === 0) {
        this.#merged = true;
        return { ok: true, summary: `fast-forward merged ${this.#session.branch} into ${target}` };
      }

      const noff = await git(this.#session.mainRoot, ["merge", "--no-ff", "--no-edit", this.#session.branch]);
      if (noff.code === 0) {
        this.#merged = true;
        return { ok: true, summary: `merged ${this.#session.branch} into ${target}` };
      }

      await git(this.#session.mainRoot, ["merge", "--abort"]);
      const detail = noff.stderr || noff.stdout || ff.stderr || "merge failed";
      const conflict = /conflict/i.test(detail) || (await hasUnmergedPaths(this.#session.mainRoot));
      return {
        ok: false,
        conflict,
        error: `merge conflict or failure; worktree kept at ${this.#session.worktreePath}: ${detail}`,
      };
    } catch (error) {
      await git(this.#session.mainRoot, ["merge", "--abort"]);
      return {
        ok: false,
        conflict: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async promptMerge(ask: AskFn, notify?: (message: string) => void): Promise<MergeResult | Readonly<{ ok: true; skipped: true }>> {
    const summary = await this.summarize();
    if (!summary.hasChanges) {
      notify?.("No unmerged worktree changes.");
      return { ok: true, skipped: true };
    }
    notify?.(summary.text);
    const approved = await ask(`Merge ${summary.filesChanged} change(s) from worktree into main tree? [y/N] `);
    if (!approved) {
      return { ok: true, skipped: true };
    }
    return this.merge();
  }

  async promptRollback(ask: AskFn, notify?: (message: string) => void): Promise<RollbackResult> {
    if (this.#merged) {
      throw new Error("cannot rollback after this session has been merged into the main tree");
    }
    const summary = await this.summarize({ includeIgnored: true });
    if (!summary.hasChanges) {
      notify?.("No session worktree changes to rollback.");
      return { ok: true, skipped: true, summary: "rollback skipped: no changes" };
    }
    notify?.(summary.text);
    const approved = await ask(`Discard ${summary.filesChanged} session change(s) and restore the session baseline? [y/N] `);
    if (!approved) {
      return { ok: true, skipped: true, summary: "rollback skipped" };
    }
    await WorktreeSandbox.rollbackToSessionBaseline(this.#session);
    return { ok: true, skipped: false, summary: `rolled back to session baseline ${this.#session.baseRef.slice(0, 12)}` };
  }

  async promptRollbackTurn(ask: AskFn, notify?: (message: string) => void): Promise<RollbackResult> {
    if (this.#merged) {
      throw new Error("cannot rollback after this session has been merged into the main tree");
    }
    const checkpoint = this.#turnCheckpoint;
    if (!checkpoint) {
      throw new Error("turn rollback is unavailable before the first prompt starts");
    }
    const summary = await WorktreeSandbox.summarizeSinceCheckpoint(this.#session, checkpoint);
    if (!summary.hasChanges) {
      notify?.("No file changes since the current turn started.");
      return { ok: true, skipped: true, summary: "turn rollback skipped: no changes" };
    }
    notify?.(summary.text);
    const approved = await ask(`Discard ${summary.filesChanged} change(s) made since this turn started? [y/N] `);
    if (!approved) {
      return { ok: true, skipped: true, summary: "turn rollback skipped" };
    }
    await WorktreeSandbox.rollbackToTurnCheckpoint(this.#session, checkpoint);
    return { ok: true, skipped: false, summary: `rolled back to turn checkpoint ${checkpoint.tree.slice(0, 12)}` };
  }

  async finalizeSession(
    ask: AskFn,
    options: { retainOnReject: boolean },
    notify?: (message: string) => void,
  ): Promise<void> {
    if (this.#merged || await WorktreeSandbox.isMerged(this.#session)) {
      this.#merged = true;
      await WorktreeSandbox.remove(this.#session, { force: true });
      notify?.("Worktree removed after merge.");
      return;
    }

    const dirty = await WorktreeSandbox.hasUnmergedChanges(this.#session);
    if (!dirty) {
      await WorktreeSandbox.remove(this.#session, { force: true });
      notify?.("Clean worktree removed.");
      return;
    }

    const summary = await this.summarize();
    notify?.(summary.text);
    const approved = await ask("Session ending with unmerged worktree changes. Merge into main tree? [y/N] ");
    if (approved) {
      const result = await this.merge();
      if (result.ok) {
        await WorktreeSandbox.remove(this.#session, { force: true });
        notify?.(result.summary);
        return;
      }
      notify?.(result.error);
      return;
    }

    if (options.retainOnReject) {
      notify?.(`Keeping worktree at ${this.#session.worktreePath}`);
      return;
    }
    await WorktreeSandbox.remove(this.#session, { force: true });
    notify?.("Discarded worktree changes.");
  }

  async #commitWorktreeIfNeeded(): Promise<void> {
    if (!(await WorktreeSandbox.hasUncommittedChanges(this.#session))) {
      return;
    }
    await gitOk(this.#session.worktreePath, ["add", "-A"]);
    const commit = await git(this.#session.worktreePath, [
      "commit",
      "-m",
      `xio session ${this.#session.sessionId}`,
      "--allow-empty-message",
    ]);
    if (commit.code !== 0) {
      throw new Error(`failed to commit worktree changes: ${commit.stderr || commit.stdout}`);
    }
  }
}

async function currentBranchOrHead(cwd: string): Promise<string> {
  const branch = await git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (branch.code === 0 && branch.stdout.trim()) {
    return branch.stdout.trim();
  }
  return gitOk(cwd, ["rev-parse", "--short", "HEAD"]);
}

async function hasUnmergedPaths(cwd: string): Promise<boolean> {
  const status = await git(cwd, ["ls-files", "--unmerged"]);
  return status.code === 0 && status.stdout.trim().length > 0;
}
