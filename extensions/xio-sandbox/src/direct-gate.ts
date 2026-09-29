import type { KernelSession } from "../../../src/runtime/process/index.ts";
import type { RollbackOperationResult, SnapshotRef } from "@xioflow/kernel";

import { git } from "./git.ts";
import type { DurableTurnCheckpoint } from "./worktree-sandbox.ts";
import type { AskFn, RollbackResult } from "./merge-gate.ts";

/** A direct-mode checkpoint is a kernel snapshot; ref/commit/tree mirror it for the session record. */
export type DirectCheckpoint = DurableTurnCheckpoint & Readonly<{
  snapshot_id: string;
  journal_seq?: number;
}>;

/**
 * Direct-mode rollback (no worktree sandbox) on top of the kernel's git-shadow
 * snapshots: capture goes through a private index and a private ref, so the
 * user's index, HEAD and branch are never touched; rollback is verified by the
 * kernel and reports its own coverage.
 *
 * Retention: the session baseline plus the current turn's snapshot. The
 * previous turn's snapshot is pruned when a new turn starts.
 */
export class DirectRollbackGate {
  readonly #kernel: KernelSession;
  #turnCheckpoint?: DirectCheckpoint;
  #baseline?: SnapshotRef;
  /** Restored from a session written before kernel snapshots; it cannot be rolled back to. */
  readonly #legacyCheckpoint: boolean;

  constructor(kernel: KernelSession, initialCheckpoint?: Partial<DirectCheckpoint> & DurableTurnCheckpoint) {
    this.#kernel = kernel;
    const restored = initialCheckpoint?.snapshot_id ? kernel.getSnapshot(initialCheckpoint.snapshot_id) : undefined;
    this.#turnCheckpoint = restored ? toCheckpoint(restored, initialCheckpoint?.head ?? "") : undefined;
    this.#legacyCheckpoint = initialCheckpoint !== undefined && !restored;
  }

  get turnCheckpoint(): DirectCheckpoint | undefined {
    return this.#turnCheckpoint;
  }

  get baselineTree(): string | undefined {
    return this.#baseline?.treeFingerprint;
  }

  async initSessionBaseline(): Promise<string> {
    this.#baseline = await this.#kernel.captureSnapshot();
    // Earlier launches of this session left their own baselines and turn
    // snapshots; only the new baseline and a restored turn checkpoint are live.
    const keep = new Set([this.#baseline.id, this.#turnCheckpoint?.snapshot_id]);
    await this.#kernel.pruneSnapshots(this.#kernel.listSnapshotIds().filter((id) => !keep.has(id)));
    return this.#baseline.treeFingerprint;
  }

  async captureTurnCheckpoint(): Promise<DirectCheckpoint> {
    const snapshot = await this.#kernel.captureSnapshot();
    const head = (await git(this.#kernel.workspaceRoot, ["rev-parse", "--verify", "HEAD"])).stdout;
    const previous = this.#turnCheckpoint;
    this.#turnCheckpoint = toCheckpoint(snapshot, head);
    if (previous && previous.snapshot_id !== this.#baseline?.id) {
      await this.#kernel.pruneSnapshots([previous.snapshot_id]);
    }
    return this.#turnCheckpoint;
  }

  async promptRollbackTurn(ask: AskFn, notify?: (message: string) => void): Promise<RollbackResult> {
    const checkpoint = this.#turnCheckpoint;
    if (!checkpoint) {
      throw new Error(this.#legacyCheckpoint
        ? "turn rollback is unavailable: this checkpoint was written by an older XioCode; the next turn records a new one"
        : "turn rollback is unavailable before the first prompt starts");
    }
    return this.#rollbackTo(checkpoint.snapshot_id, "turn", ask, notify);
  }

  async promptRollback(ask: AskFn, notify?: (message: string) => void): Promise<RollbackResult> {
    if (!this.#baseline) {
      notify?.("No session baseline recorded to roll back to.");
      return { ok: true, skipped: true, summary: "session rollback skipped: no baseline" };
    }
    const result = await this.#rollbackTo(this.#baseline.id, "session", ask, notify);
    if (!result.skipped) {
      this.#turnCheckpoint = undefined;
    }
    return result;
  }

  async #rollbackTo(
    snapshotId: string,
    scope: "turn" | "session",
    ask: AskFn,
    notify?: (message: string) => void,
  ): Promise<RollbackResult> {
    const snapshot = this.#kernel.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new Error(`${scope} rollback is unavailable: kernel snapshot ${snapshotId} no longer exists`);
    }
    const root = this.#kernel.workspaceRoot;
    const currentTree = await this.#kernel.currentTreeAgainst(snapshot);
    if (currentTree === snapshot.treeFingerprint) {
      const since = scope === "turn" ? "the current turn started" : "the session started";
      notify?.(`No file changes since ${since}.`);
      return { ok: true, skipped: true, summary: `${scope} rollback skipped: no changes` };
    }

    const diffText = (await git(root, ["diff", "--no-ext-diff", snapshot.treeFingerprint, currentTree])).stdout.trim();
    if (diffText.length > 0) {
      notify?.(diffText);
    }
    const changed = (await git(root, ["diff-tree", "-r", "-z", "--name-only", snapshot.treeFingerprint, currentTree]))
      .stdout.split("\0").filter(Boolean).length;
    const target = scope === "turn" ? "turn checkpoint" : "session baseline";
    const approved = await ask(`Discard ${changed} change(s) and restore the ${target}? [y/N] `, diffText);
    if (!approved) {
      return { ok: true, skipped: true, summary: `${scope} rollback skipped` };
    }

    const result = await this.#kernel.rollback(snapshotId);
    const summary = describeRollback(result, snapshot, target);
    if (result.status === "failed") {
      throw new Error(summary);
    }
    return { ok: true, skipped: false, summary };
  }
}

function toCheckpoint(snapshot: SnapshotRef, head: string): DirectCheckpoint {
  return {
    head,
    tree: snapshot.treeFingerprint,
    commit: snapshot.commitHash ?? snapshot.treeFingerprint,
    ref: `refs/xioflow/snapshots/${snapshot.id}`,
    snapshot_id: snapshot.id,
    ...(snapshot.journalSeq !== undefined ? { journal_seq: snapshot.journalSeq } : {}),
  };
}

/** The kernel's verdict in words, including what it cannot vouch for. */
export function describeRollback(
  result: RollbackOperationResult,
  snapshot: SnapshotRef,
  target: string,
): string {
  const lines: string[] = [];
  const shortTree = snapshot.treeFingerprint.slice(0, 12);
  if (result.status === "restored") {
    lines.push(`Restored the ${target} (${shortTree}); the kernel verified the files by fingerprint.`);
  } else if (result.status === "partial") {
    lines.push(`Partially restored the ${target} (${shortTree}); these paths could not be restored:`);
    lines.push(...(result.unrestoredPaths ?? []).map((p) => `  ${p}`));
  } else {
    lines.push(`Rollback to the ${target} (${shortTree}) failed: ${result.errorMessage ?? "unknown error"}`);
  }
  if (snapshot.coverage === "worktree_non_ignored") {
    lines.push("Ignored files (.gitignore: e.g. .env, node_modules, build output) were not snapshotted and are unchanged.");
  }
  if (result.outOfScopeEffects === "possible") {
    lines.push(
      "Commands ran without write confinement since this checkpoint, so effects outside the workspace "
        + "(other directories, databases, network) may remain and were not rolled back.",
    );
  }
  return lines.join("\n");
}
