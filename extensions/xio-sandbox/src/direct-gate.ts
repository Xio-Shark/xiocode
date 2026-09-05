import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { git, gitOk, gitWithEnvOk } from "./git.ts";
import { WorktreeSandbox, type DurableTurnCheckpoint, type TurnCheckpoint } from "./worktree-sandbox.ts";
import type { AskFn, RollbackResult } from "./merge-gate.ts";

/**
 * Direct-mode rollback gate for working trees outside worktree sandbox mode.
 * Captures visible tree snapshots into Git objects using a temporary index,
 * enabling safe, non-destructive `/rollback turn` and `/rollback` without
 * touching the user's live index or pre-existing uncommitted files.
 */
export class DirectRollbackGate {
  readonly #workspaceRoot: string;
  #turnCheckpoint?: DurableTurnCheckpoint | TurnCheckpoint;
  #baselineTree?: string;

  constructor(workspaceRoot: string, initialCheckpoint?: DurableTurnCheckpoint | TurnCheckpoint) {
    this.#workspaceRoot = path.resolve(workspaceRoot);
    this.#turnCheckpoint = initialCheckpoint;
  }

  get turnCheckpoint(): DurableTurnCheckpoint | TurnCheckpoint | undefined {
    return this.#turnCheckpoint;
  }

  get baselineTree(): string | undefined {
    return this.#baselineTree;
  }

  async initSessionBaseline(): Promise<string | undefined> {
    try {
      const head = await gitOk(this.#workspaceRoot, ["rev-parse", "HEAD"]);
      this.#baselineTree = await WorktreeSandbox.captureVisibleTree(this.#workspaceRoot, head);
      return this.#baselineTree;
    } catch {
      return undefined;
    }
  }

  async captureTurnCheckpoint(checkpointId = randomUUID().replaceAll("-", "")): Promise<DurableTurnCheckpoint> {
    const head = await gitOk(this.#workspaceRoot, ["rev-parse", "HEAD"]);
    const tree = await WorktreeSandbox.captureVisibleTree(this.#workspaceRoot, head);
    const commit = await gitWithEnvOk(
      this.#workspaceRoot,
      ["commit-tree", tree, "-p", head, "-m", `XioCode direct checkpoint ${checkpointId}`],
      {
        GIT_AUTHOR_NAME: "XioCode Checkpoint",
        GIT_AUTHOR_EMAIL: "checkpoint@xiocode.local",
        GIT_COMMITTER_NAME: "XioCode Checkpoint",
        GIT_COMMITTER_EMAIL: "checkpoint@xiocode.local",
      },
    );
    const ref = `refs/xiocode/checkpoints/direct/${checkpointId}`;
    try {
      await gitOk(this.#workspaceRoot, ["update-ref", ref, commit]);
    } catch {
      // Best-effort ref update
    }
    const checkpoint: DurableTurnCheckpoint = { head, tree, ref, commit };
    this.#turnCheckpoint = checkpoint;
    return checkpoint;
  }

  async promptRollbackTurn(ask: AskFn, notify?: (message: string) => void): Promise<RollbackResult> {
    const checkpoint = this.#turnCheckpoint;
    if (!checkpoint) {
      throw new Error("turn rollback is unavailable before the first prompt starts");
    }
    const currentTree = await WorktreeSandbox.captureVisibleTree(this.#workspaceRoot, checkpoint.head);
    if (currentTree === checkpoint.tree) {
      notify?.("No file changes since the current turn started.");
      return { ok: true, skipped: true, summary: "turn rollback skipped: no changes" };
    }

    const diffOutput = await git(this.#workspaceRoot, ["diff", "--no-ext-diff", checkpoint.tree, currentTree]);
    const diffText = diffOutput.stdout.trim();
    if (diffText.length > 0) {
      notify?.(diffText);
    }

    const diffTree = await gitOk(this.#workspaceRoot, ["diff-tree", "-r", "--name-status", checkpoint.tree, currentTree]);
    const lines = diffTree.split("\n").filter(Boolean);
    const approved = await ask(
      `Discard ${lines.length} change(s) from this turn and restore turn checkpoint? [y/N] `,
      diffText,
    );
    if (!approved) {
      return { ok: true, skipped: true, summary: "turn rollback skipped" };
    }

    for (const line of lines) {
      const [action, ...rest] = line.split("\t");
      const file = rest.join("\t");
      if (!file) continue;
      const targetPath = path.join(this.#workspaceRoot, file);
      if (action === "A") {
        await rm(targetPath, { force: true, recursive: true });
      } else {
        await gitOk(this.#workspaceRoot, ["checkout", checkpoint.tree, "--", file]);
      }
    }

    return {
      ok: true,
      skipped: false,
      summary: `rolled back turn changes to checkpoint ${checkpoint.tree.slice(0, 12)}`,
    };
  }

  async promptRollback(ask: AskFn, notify?: (message: string) => void): Promise<RollbackResult> {
    const targetTree = this.#baselineTree ?? this.#turnCheckpoint?.tree;
    const targetHead = this.#turnCheckpoint?.head ?? "HEAD";
    if (!targetTree) {
      notify?.("No session checkpoint recorded to rollback to.");
      return { ok: true, skipped: true, summary: "session rollback skipped: no checkpoint" };
    }

    const currentTree = await WorktreeSandbox.captureVisibleTree(this.#workspaceRoot, targetHead);
    if (currentTree === targetTree) {
      notify?.("No file changes since session baseline.");
      return { ok: true, skipped: true, summary: "session rollback skipped: no changes" };
    }

    const diffOutput = await git(this.#workspaceRoot, ["diff", "--no-ext-diff", targetTree, currentTree]);
    const diffText = diffOutput.stdout.trim();
    if (diffText.length > 0) {
      notify?.(diffText);
    }

    const diffTree = await gitOk(this.#workspaceRoot, ["diff-tree", "-r", "--name-status", targetTree, currentTree]);
    const lines = diffTree.split("\n").filter(Boolean);
    const approved = await ask(
      `Discard ${lines.length} change(s) and restore session baseline? [y/N] `,
      diffText,
    );
    if (!approved) {
      return { ok: true, skipped: true, summary: "session rollback skipped" };
    }

    for (const line of lines) {
      const [action, ...rest] = line.split("\t");
      const file = rest.join("\t");
      if (!file) continue;
      const targetPath = path.join(this.#workspaceRoot, file);
      if (action === "A") {
        await rm(targetPath, { force: true, recursive: true });
      } else {
        await gitOk(this.#workspaceRoot, ["checkout", targetTree, "--", file]);
      }
    }

    this.#turnCheckpoint = undefined;
    return {
      ok: true,
      skipped: false,
      summary: `rolled back to session baseline ${targetTree.slice(0, 12)}`,
    };
  }
}
