import { WorktreeSandbox } from "./worktree-sandbox.ts";

import { git, gitOk } from "./git.ts";

import type { DurableTurnCheckpoint, TurnCheckpoint, WorktreeSession } from "./worktree-sandbox.ts";

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

/** Optional second arg is action-specific detail shown in the confirmation UI. */
export type AskFn = (question: string, detail?: string) => Promise<boolean>;
export type WorktreeDisposition = "merged" | "clean_removed" | "retained" | "discarded";

export class MergeGate {
  readonly #session: WorktreeSession;
  #merged = false;
  #turnCheckpoint: DurableTurnCheckpoint | TurnCheckpoint | undefined;
  #checkpointCleared: (() => Promise<void> | void) | undefined;

  constructor(session: WorktreeSession, checkpoint?: DurableTurnCheckpoint) {
    this.#session = session;
    this.#turnCheckpoint = checkpoint;
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

  setCheckpointClearedHandler(handler: () => Promise<void> | void): void {
    this.#checkpointCleared = handler;
  }

  async captureTurnCheckpoint(): Promise<DurableTurnCheckpoint> {
    if (this.#merged) {
      throw new Error("cannot checkpoint after this session has been merged into the main tree");
    }
    const checkpoint = await WorktreeSandbox.captureDurableCheckpoint(this.#session);
    this.#turnCheckpoint = checkpoint;
    return checkpoint;
  }

  async summarize(options: { includeIgnored?: boolean } = {}): Promise<DiffSummary> {
    // Agent delta is baselineTree → current visible tree (launch WIP is not agent change).
    const baselineSummary = await WorktreeSandbox.summarizeSinceBaseline(this.#session);
    const statusArgs = ["status", "--short", "--untracked-files=all"];
    if (options.includeIgnored) statusArgs.push("--ignored=matching");
    const worktreeStatus = await git(this.#session.worktreePath, statusArgs);
    const uncommittedFiles = worktreeStatus.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const uncommitted = uncommittedFiles.some((line) => !line.startsWith("!!"));

    // Branch commits ahead of main (clean-baseline path may commit on the session branch).
    const nameStatus = await git(this.#session.mainRoot, [
      "diff",
      "--name-status",
      `${this.#session.baseRef}...${this.#session.branch}`,
    ]);
    const committedFiles = nameStatus.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const filesChanged = Math.max(baselineSummary.filesChanged, committedFiles.length);
    const parts: string[] = [];
    if (baselineSummary.hasChanges) {
      parts.push(baselineSummary.text);
    }
    if (committedFiles.length > 0 && !baselineSummary.hasChanges) {
      const unified = await git(this.#session.worktreePath, ["diff", "--no-ext-diff", this.#session.baseRef]);
      if (unified.stdout.trim().length > 0) {
        parts.push(unified.stdout.trim());
      }
    }
    if (worktreeStatus.stdout.trim().length > 0 && (baselineSummary.hasChanges || options.includeIgnored)) {
      parts.push("Worktree status:");
      parts.push(worktreeStatus.stdout.trim());
    }
    if (parts.length === 0) {
      parts.push("(no changes relative to session baseline)");
    }

    return {
      text: parts.join("\n"),
      hasChanges: baselineSummary.hasChanges || committedFiles.length > 0,
      filesChanged: filesChanged || (uncommitted && baselineSummary.hasChanges ? 1 : 0),
      uncommitted: uncommitted && baselineSummary.hasChanges,
    };
  }

  async merge(): Promise<MergeResult> {
    if (this.#merged) {
      return { ok: true, summary: "already merged" };
    }

    try {
      if (await WorktreeSandbox.isDirtyBaseline(this.#session)) {
        return await this.#mergeDirtyDelta();
      }
      return await this.#mergeCleanBaseline();
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
    const approved = await ask(
      `Merge ${summary.filesChanged} change(s) from worktree into main tree? [y/N] `,
      summary.text,
    );
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
    const approved = await ask(
      `Discard ${summary.filesChanged} session change(s) and restore the session baseline? [y/N] `,
      summary.text,
    );
    if (!approved) {
      return { ok: true, skipped: true, summary: "rollback skipped" };
    }
    const checkpoint = this.#turnCheckpoint;
    const recovery = await WorktreeSandbox.captureTurnCheckpoint(this.#session);
    await WorktreeSandbox.rollbackToSessionBaseline(this.#session);
    this.#turnCheckpoint = undefined;
    try {
      await this.#checkpointCleared?.();
    } catch (error) {
      await WorktreeSandbox.rollbackToTurnCheckpoint(this.#session, recovery);
      this.#turnCheckpoint = checkpoint;
      throw error;
    }
    if (checkpoint && "ref" in checkpoint) {
      await WorktreeSandbox.releaseCheckpoint(this.#session, checkpoint);
    }
    return {
      ok: true,
      skipped: false,
      summary: `rolled back to session baseline ${this.#session.baselineTree.slice(0, 12)}`,
    };
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
    const approved = await ask(
      `Discard ${summary.filesChanged} change(s) made since this turn started? [y/N] `,
      summary.text,
    );
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
    beforeFinalize?: (disposition: WorktreeDisposition) => Promise<void> | void,
  ): Promise<WorktreeDisposition> {
    if (this.#merged || await WorktreeSandbox.isMerged(this.#session)) {
      this.#merged = true;
      await beforeFinalize?.("merged");
      try {
        await WorktreeSandbox.remove(this.#session, { force: true });
      } catch (error) {
        await beforeFinalize?.("retained");
        throw error;
      }
      await WorktreeSandbox.releaseSessionCheckpoints(this.#session);
      notify?.("Worktree removed after merge.");
      return "merged";
    }

    const dirty = await WorktreeSandbox.hasUnmergedChanges(this.#session);
    if (!dirty) {
      await beforeFinalize?.("clean_removed");
      try {
        await WorktreeSandbox.remove(this.#session, { force: true });
      } catch (error) {
        await beforeFinalize?.("retained");
        throw error;
      }
      await WorktreeSandbox.releaseSessionCheckpoints(this.#session);
      notify?.("Clean worktree removed.");
      return "clean_removed";
    }

    const summary = await this.summarize();
    notify?.(summary.text);
    const approved = await ask(
      "Session ending with unmerged worktree changes. Merge into main tree? [y/N] ",
      summary.text,
    );
    if (approved) {
      const result = await this.merge();
      if (result.ok) {
        await beforeFinalize?.("merged");
        try {
          await WorktreeSandbox.remove(this.#session, { force: true });
        } catch (error) {
          await beforeFinalize?.("retained");
          throw error;
        }
        await WorktreeSandbox.releaseSessionCheckpoints(this.#session);
        notify?.(result.summary);
        return "merged";
      }
      notify?.(result.error);
      await beforeFinalize?.("retained");
      return "retained";
    }

    if (options.retainOnReject) {
      await beforeFinalize?.("retained");
      notify?.(`Keeping worktree at ${this.#session.worktreePath}`);
      return "retained";
    }
    await beforeFinalize?.("discarded");
    try {
      await WorktreeSandbox.remove(this.#session, { force: true });
    } catch (error) {
      await beforeFinalize?.("retained");
      throw error;
    }
    await WorktreeSandbox.releaseSessionCheckpoints(this.#session);
    notify?.("Discarded worktree changes.");
    return "discarded";
  }

  async #mergeCleanBaseline(): Promise<MergeResult> {
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

  /**
   * Dirty baseline: transfer only baseline → candidate agent delta onto the main
   * working tree. Preserve the original main index (staged state). Never commit
   * launch WIP. Fail closed if main visible tree drifted from baseline.
   */
  async #mergeDirtyDelta(): Promise<MergeResult> {
    const main = this.#session.mainRoot;
    const candidate = this.#session.worktreePath;
    const baseline = this.#session.baselineTree;
    let originalIndexTree: string | undefined;

    try {
      if (await hasUnmergedPaths(main)) {
        return {
          ok: false,
          conflict: true,
          error: `main index has unresolved conflicts; worktree kept at ${candidate}`,
        };
      }

      const mainVisible = await WorktreeSandbox.captureVisibleTree(main, this.#session.baseRef);
      if (mainVisible !== baseline) {
        return {
          ok: false,
          conflict: false,
          error: [
            "main tree drifted from session baseline; merge refused (fail closed).",
            `worktree kept at ${candidate}`,
          ].join(" "),
        };
      }

      originalIndexTree = await gitOk(main, ["write-tree"]);

      const candidateTree = await WorktreeSandbox.captureVisibleTree(candidate, this.#session.baseRef);
      if (candidateTree === baseline) {
        await this.#markCandidateMergedOntoMain();
        this.#merged = true;
        return { ok: true, summary: "no agent changes relative to session baseline" };
      }

      // Index = baseline (WT already matches baseline), then apply candidate to WT+index.
      await gitOk(main, ["read-tree", baseline]);
      await gitOk(main, ["read-tree", "--reset", "-u", candidateTree]);
      // Restore original staged state without rewriting working tree.
      await gitOk(main, ["read-tree", originalIndexTree]);

      await this.#markCandidateMergedOntoMain();
      this.#merged = true;
      return {
        ok: true,
        summary: `applied agent delta onto main working tree (dirty baseline; index preserved)`,
      };
    } catch (error) {
      await recoverMainAfterDirtyMergeFailure(main, baseline, originalIndexTree, this.#session.baseRef);
      return {
        ok: false,
        conflict: false,
        error: [
          error instanceof Error ? error.message : String(error),
          `worktree kept at ${candidate}`,
        ].join("; "),
      };
    }
  }

  /** Point session branch at main HEAD so isMerged/finalize treat the transfer as done. */
  async #markCandidateMergedOntoMain(): Promise<void> {
    const mainHead = await gitOk(this.#session.mainRoot, ["rev-parse", "HEAD"]);
    await gitOk(this.#session.worktreePath, ["reset", "--mixed", mainHead]);
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

async function recoverMainAfterDirtyMergeFailure(
  main: string,
  baseline: string,
  originalIndexTree: string | undefined,
  baseRef: string,
): Promise<void> {
  try {
    await gitOk(main, ["read-tree", "--reset", "-u", baseline]);
    await gitOk(main, ["reset", "--mixed", baseRef]);
    if (originalIndexTree) {
      await gitOk(main, ["read-tree", originalIndexTree]);
    }
  } catch {
    // best-effort recovery; original error is returned to caller
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
