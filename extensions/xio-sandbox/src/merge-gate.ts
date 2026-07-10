import { WorktreeSandbox } from "./worktree-sandbox.ts";

import { git, gitOk } from "./git.ts";

import type { WorktreeSession } from "./worktree-sandbox.ts";

export type DiffSummary = Readonly<{
  text: string;
  hasChanges: boolean;
  filesChanged: number;
  uncommitted: boolean;
}>;

export type MergeResult =
  | Readonly<{ ok: true; summary: string }>
  | Readonly<{ ok: false; error: string; conflict: boolean }>;

export type AskFn = (question: string) => Promise<boolean>;

export class MergeGate {
  readonly #session: WorktreeSession;
  #merged = false;

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

  async summarize(): Promise<DiffSummary> {
    const uncommitted = await WorktreeSandbox.hasUncommittedChanges(this.#session);
    const range = `${this.#session.baseRef}...${this.#session.branch}`;
    const nameStatus = await git(this.#session.mainRoot, ["diff", "--name-status", range]);
    const stat = await git(this.#session.mainRoot, ["diff", "--stat", range]);
    const worktreeStatus = uncommitted
      ? await git(this.#session.worktreePath, ["status", "--short"])
      : { stdout: "", stderr: "", code: 0 };

    const committedFiles = nameStatus.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const uncommittedFiles = worktreeStatus.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const filesChanged = new Set([
      ...committedFiles.map((line) => line.replace(/^[A-Z]+\s+/, "")),
      ...uncommittedFiles.map((line) => line.replace(/^..\s+/, "")),
    ]).size;

    const parts: string[] = [];
    if (stat.stdout.trim().length > 0) {
      parts.push(stat.stdout.trim());
    }
    if (uncommitted && worktreeStatus.stdout.trim().length > 0) {
      parts.push("Uncommitted in worktree:");
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
