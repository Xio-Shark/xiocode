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
 * Retention: the session baseline plus the snapshots taken at the start of the
 * last `retainTurns` turns (rewind points). Older turn snapshots are pruned
 * when a new turn starts.
 */
export const DEFAULT_RETAINED_TURNS = 20;

export class DirectRollbackGate {
  readonly #kernel: KernelSession;
  readonly #retainTurns: number;
  #turnCheckpoint?: DirectCheckpoint;
  #baseline?: SnapshotRef;
  /** Turn-start snapshot ids, oldest first. */
  #turnSnapshots: string[] = [];
  /** Restored from a session written before kernel snapshots; it cannot be rolled back to. */
  readonly #legacyCheckpoint: boolean;

  constructor(
    kernel: KernelSession,
    initialCheckpoint?: Partial<DirectCheckpoint> & DurableTurnCheckpoint,
    options: Readonly<{ retainTurns?: number }> = {},
  ) {
    this.#kernel = kernel;
    this.#retainTurns = Math.max(1, options.retainTurns ?? DEFAULT_RETAINED_TURNS);
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

  /**
   * Takes this launch's baseline. Earlier launches of the session left their
   * own baselines and turn snapshots; only the new baseline, a restored turn
   * checkpoint and `keepTurnSnapshots` (rewind points that are still listed,
   * oldest first) stay live.
   */
  async initSessionBaseline(keepTurnSnapshots: readonly string[] = []): Promise<string> {
    this.#baseline = await this.#kernel.captureSnapshot();
    const existing = new Set(this.#kernel.listSnapshotIds());
    this.#turnSnapshots = [...keepTurnSnapshots, this.#turnCheckpoint?.snapshot_id]
      .filter((id): id is string => id !== undefined && existing.has(id))
      .filter((id, index, all) => all.indexOf(id) === index)
      .slice(-this.#retainTurns);
    const keep = new Set([this.#baseline.id, ...this.#turnSnapshots]);
    await this.#kernel.pruneSnapshots([...existing].filter((id) => !keep.has(id)));
    return this.#baseline.treeFingerprint;
  }

  async captureTurnCheckpoint(): Promise<DirectCheckpoint> {
    const snapshot = await this.#kernel.captureSnapshot();
    const head = (await git(this.#kernel.workspaceRoot, ["rev-parse", "--verify", "HEAD"])).stdout;
    this.#turnCheckpoint = toCheckpoint(snapshot, head);
    this.#turnSnapshots.push(snapshot.id);
    const expired = this.#turnSnapshots.splice(0, Math.max(0, this.#turnSnapshots.length - this.#retainTurns))
      .filter((id) => id !== this.#baseline?.id);
    await this.#kernel.pruneSnapshots(expired);
    return this.#turnCheckpoint;
  }

  /** Whether a turn-start snapshot is still retained (rewind can restore its files). */
  hasTurnSnapshot(snapshotId: string): boolean {
    return this.#turnSnapshots.includes(snapshotId) && this.#kernel.getSnapshot(snapshotId) !== undefined;
  }

  /**
   * Restores the files of a retained turn-start snapshot (rewind). Later turn
   * snapshots are kept: the caller drops them (`dropTurnSnapshotsAfter`) when
   * the conversation is rewound too.
   */
  async restoreTurnSnapshot(
    snapshotId: string,
    label: string,
    ask: AskFn,
    notify?: (message: string) => void,
  ): Promise<RollbackResult> {
    if (!this.hasTurnSnapshot(snapshotId)) {
      throw new Error(`rewind is unavailable: the snapshot of ${label} is no longer retained`);
    }
    return this.#rollbackTo(snapshotId, "turn", ask, notify, label);
  }

  /**
   * Forgets (and prunes) the turn snapshots taken after `snapshotId`, which
   * becomes the turn checkpoint: files and conversation are back at that turn.
   */
  async dropTurnSnapshotsAfter(snapshotId: string): Promise<void> {
    const index = this.#turnSnapshots.indexOf(snapshotId);
    if (index < 0) return;
    const later = this.#turnSnapshots.splice(index + 1);
    const snapshot = this.#kernel.getSnapshot(snapshotId);
    if (snapshot) {
      this.#turnCheckpoint = toCheckpoint(snapshot, this.#turnCheckpoint?.head ?? "");
    }
    await this.#kernel.pruneSnapshots(later.filter((id) => id !== this.#baseline?.id));
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
    label?: string,
  ): Promise<RollbackResult> {
    const snapshot = this.#kernel.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new Error(`${scope} rollback is unavailable: kernel snapshot ${snapshotId} no longer exists`);
    }
    const root = this.#kernel.workspaceRoot;
    const currentTree = await this.#kernel.currentTreeAgainst(snapshot);
    if (currentTree === snapshot.treeFingerprint) {
      const since = label ?? (scope === "turn" ? "the current turn started" : "the session started");
      notify?.(`No file changes since ${since}.`);
      return { ok: true, skipped: true, unchanged: true, summary: `${scope} rollback skipped: no changes` };
    }

    const diffText = (await git(root, ["diff", "--no-ext-diff", snapshot.treeFingerprint, currentTree])).stdout.trim();
    if (diffText.length > 0) {
      notify?.(diffText);
    }
    const changed = (await git(root, ["diff-tree", "-r", "-z", "--name-only", snapshot.treeFingerprint, currentTree]))
      .stdout.split("\0").filter(Boolean).length;
    const target = label ?? (scope === "turn" ? "turn checkpoint" : "session baseline");
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
