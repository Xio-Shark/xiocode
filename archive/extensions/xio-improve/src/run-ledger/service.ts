import { createHash } from "node:crypto";

import { reduceTransition } from "./reducer.ts";
import { RunLedgerStore } from "./store.ts";
import {
  FAILURE_SIGNATURE_STOP_AT,
  FAILURE_SIGNATURE_WARN_AT,
  RECEIPT_SCHEMA,
  RUN_STATE_SCHEMA,
  type ContinuationBlocker,
  type EvidenceRefs,
  type ImprovementRunState,
  type MergeReceipt,
  type RunContinuation,
  type RunOutcome,
  type TransitionInput,
  type VerifierReceipt,
} from "./types.ts";

import type { ImproveGoal } from "../types.ts";

export class LedgerClaimError extends Error {
  readonly existingRunId?: string;

  constructor(message: string, existingRunId?: string) {
    super(message);
    this.name = "LedgerClaimError";
    if (existingRunId !== undefined) {
      this.existingRunId = existingRunId;
    }
  }
}

export class RepeatedFailureStop extends Error {
  readonly signature: string;
  readonly consecutive: number;

  constructor(message: string, signature: string, consecutive: number) {
    super(message);
    this.name = "RepeatedFailureStop";
    this.signature = signature;
    this.consecutive = consecutive;
  }
}

/** Stable goal identity over normalized fields (R3.1); prompt by hash only. */
export function goalFingerprint(goal: ImproveGoal): string {
  const hash = createHash("sha256");
  hash.update(goal.source);
  hash.update("\u0000");
  hash.update(goal.id.trim());
  hash.update("\u0000");
  hash.update(goal.title.trim());
  hash.update("\u0000");
  hash.update(createHash("sha256").update(goal.prompt.trim()).digest("hex"));
  return hash.digest("hex").slice(0, 24);
}

/** Failure signature over stable facts, not error prose (R6.1). */
export function failureSignature(input: Readonly<{
  goalFingerprint: string;
  baseRevision: string;
  candidateRevision: string | null;
  failureClass: string;
  failedChecks: readonly string[];
}>): string {
  const hash = createHash("sha256");
  hash.update(input.goalFingerprint);
  hash.update("\u0000");
  hash.update(input.baseRevision);
  hash.update("\u0000");
  hash.update(input.candidateRevision ?? "");
  hash.update("\u0000");
  hash.update(input.failureClass);
  hash.update("\u0000");
  hash.update([...input.failedChecks].sort().join(","));
  return hash.digest("hex").slice(0, 24);
}

export type ClaimInput = Readonly<{
  goal: ImproveGoal;
  sourceRef?: string | null;
  repoId: string;
  commonDir: string;
  baseRevision: string;
  baselineTree?: string | null;
}>;

export type RunHandle = Readonly<{
  runId: string;
  state: ImprovementRunState;
}>;

export type ImprovementRunServiceOptions = Readonly<{
  store: RunLedgerStore;
  /** Injected candidateRevision() from xio-eval; never reimplemented here (R4.4). */
  revisionOf: (root: string) => Promise<string>;
  now?: () => string;
}>;

/**
 * Single owner of improvement-run claims and phase transitions (R2/R3).
 * `SelfImproveRunner` and the CLI call this service; neither infers phase.
 */
export class ImprovementRunService {
  readonly #store: RunLedgerStore;
  readonly #revisionOf: (root: string) => Promise<string>;
  readonly #now: () => string;

  constructor(options: ImprovementRunServiceOptions) {
    this.#store = options.store;
    this.#revisionOf = options.revisionOf;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get store(): RunLedgerStore {
    return this.#store;
  }

  /** Candidate content identity via the injected trusted primitive (R4.4). */
  async candidateRevision(root: string): Promise<string> {
    return this.#revisionOf(root);
  }

  /**
   * Durable claim before any worktree exists (R3.2/R3.4). Rejects goals with
   * an active or terminal run for the same fingerprint unless `retryOf` names
   * that run explicitly (new attempt with lineage).
   */
  async claim(input: ClaimInput, options: Readonly<{
    retryOf?: string;
    overrideReason?: string;
  }> = {}): Promise<RunHandle> {
    const fingerprint = goalFingerprint(input.goal);
    const existing = await this.findByFingerprint(fingerprint);
    let attempt = 1;
    let parentRunId: string | null = null;
    if (options.retryOf !== undefined) {
      const parent = existing.find((run) => run.run_id === options.retryOf);
      if (!parent) {
        throw new LedgerClaimError(`retry target ${options.retryOf} does not claim goal ${input.goal.id}`);
      }
      if (parent.phase !== "terminal") {
        throw new LedgerClaimError(
          `retry target ${parent.run_id} is still ${parent.phase}; resume or abandon it first`,
          parent.run_id,
        );
      }
      await this.#enforceRepeatedFailurePolicy(existing, options.overrideReason, parent.run_id);
      attempt = parent.attempt + 1;
      parentRunId = parent.run_id;
    } else if (existing.length > 0) {
      const latest = existing[existing.length - 1];
      if (!latest) {
        throw new LedgerClaimError("unreachable: empty claim list");
      }
      throw new LedgerClaimError(
        latest.phase === "terminal"
          ? `goal ${input.goal.id} already has terminal run ${latest.run_id} (${latest.outcome ?? "unknown"}); use retry to create a new attempt`
          : `goal ${input.goal.id} is already claimed by ${latest.phase} run ${latest.run_id}`,
        latest.run_id,
      );
    }

    const at = this.#now();
    const runId = `${at.replace(/[-:.TZ]/g, "").slice(0, 14)}-${fingerprint.slice(0, 8)}-a${attempt}`;
    const state: ImprovementRunState = {
      schema: RUN_STATE_SCHEMA,
      run_id: runId,
      revision: 0,
      goal: {
        id: input.goal.id,
        fingerprint,
        source: input.goal.source,
        source_ref: input.sourceRef ?? null,
        title: input.goal.title,
      },
      attempt,
      parent_run_id: parentRunId,
      repository: {
        repo_id: input.repoId,
        common_dir: input.commonDir,
        base_revision: input.baseRevision,
        baseline_tree: input.baselineTree ?? null,
      },
      candidate: { worktree_path: null, branch: null, revision: null, base_ref: null, baseline_tree: null },
      phase: "created",
      disposition: "running",
      outcome: null,
      failure_signature: null,
      evidence: {
        verifier_receipt: null,
        private_case_id: null,
        private_status: null,
        eval_id: null,
        capability_status: null,
        merge_receipt: null,
      },
      created_at: at,
      updated_at: at,
    };
    const created = await this.#store.createRun(state);
    if (!created) {
      throw new LedgerClaimError(`run id ${runId} already exists; concurrent claim lost the race`, runId);
    }
    if (options.overrideReason) {
      // One-use override is an audit event on the new attempt (R6.3).
      const { state: next, event } = reduceTransition(state, {
        to: "created",
        kind: "override",
        reason: `manual_override: ${options.overrideReason}`,
        at: this.#now(),
      });
      await this.#store.commitTransition(next, event);
      return { runId, state: next };
    }
    return { runId, state };
  }

  /** Applies one transition through the reducer and commits it (WAL first). */
  async advance(state: ImprovementRunState, input: TransitionInput): Promise<ImprovementRunState> {
    const { state: next, event } = reduceTransition(state, { at: this.#now(), ...input });
    await this.#store.commitTransition(next, event);
    return next;
  }

  async load(runId: string): Promise<ImprovementRunState> {
    const { state } = await this.#store.loadRun(runId);
    return state;
  }

  async list(): Promise<readonly ImprovementRunState[]> {
    const ids = await this.#store.listRunIds();
    const states: ImprovementRunState[] = [];
    for (const id of ids) {
      const { state } = await this.#store.loadRun(id);
      states.push(state);
    }
    return states;
  }

  async findByFingerprint(fingerprint: string): Promise<readonly ImprovementRunState[]> {
    const all = await this.list();
    return all
      .filter((state) => state.goal.fingerprint === fingerprint)
      .sort((a, b) => a.attempt - b.attempt);
  }

  /** Verifier receipt bound to candidate revisions before/after (R4.1). */
  async recordVerifierReceipt(state: ImprovementRunState, input: Readonly<{
    worktreePath: string;
    revisionBefore: string;
    commands: readonly string[];
    ok: boolean;
    exitCode: number;
    output: string;
    startedAt: string;
  }>): Promise<Readonly<{ ref: string; receipt: VerifierReceipt; revisionAfter: string }>> {
    const revisionAfter = await this.#revisionOf(input.worktreePath);
    const staleReasons = revisionAfter === input.revisionBefore
      ? []
      : [`candidate changed during verification (${input.revisionBefore} -> ${revisionAfter})`];
    const receipt: VerifierReceipt = {
      schema: RECEIPT_SCHEMA,
      kind: "verifier",
      run_id: state.run_id,
      state_revision: state.revision,
      candidate_revision_before: input.revisionBefore,
      candidate_revision_after: revisionAfter,
      commands: input.commands,
      ok: input.ok,
      exit_code: input.exitCode,
      output_hash: createHash("sha256").update(input.output).digest("hex"),
      started_at: input.startedAt,
      ended_at: this.#now(),
      stale_reasons: staleReasons,
    };
    const ref = await this.#store.writeReceipt(
      state.run_id,
      `verifier-${receipt.candidate_revision_after.replace(/[^a-zA-Z0-9-]/g, "")}-r${state.revision}.json`,
      receipt,
    );
    return { ref, receipt, revisionAfter };
  }

  async recordMergeReceipt(state: ImprovementRunState, input: Readonly<{
    candidateRevision: string;
    asked: boolean;
    approved: boolean | null;
    merged: boolean | null;
    detail: string;
  }>): Promise<string> {
    const receipt: MergeReceipt = {
      schema: RECEIPT_SCHEMA,
      kind: "merge",
      run_id: state.run_id,
      state_revision: state.revision,
      candidate_revision: input.candidateRevision,
      asked: input.asked,
      approved: input.approved,
      merged: input.merged,
      detail: input.detail,
      at: this.#now(),
    };
    return this.#store.writeReceipt(
      state.run_id,
      `merge-${input.candidateRevision.replace(/[^a-zA-Z0-9-]/g, "")}-r${state.revision}.json`,
      receipt,
    );
  }

  /**
   * Merge eligibility (R4.3): all evidence must bind to the live candidate
   * revision. Any mismatch returns stale reasons; the caller retreats to
   * verifying instead of asking MergeGate with old receipts.
   */
  async checkMergeEligibility(state: ImprovementRunState): Promise<Readonly<{
    eligible: boolean;
    liveRevision: string | null;
    staleReasons: readonly string[];
  }>> {
    const reasons: string[] = [];
    if (!state.candidate.worktree_path) {
      return { eligible: false, liveRevision: null, staleReasons: ["candidate worktree unknown"] };
    }
    let liveRevision: string | null = null;
    try {
      liveRevision = await this.#revisionOf(state.candidate.worktree_path);
    } catch (error) {
      return {
        eligible: false,
        liveRevision: null,
        staleReasons: [`candidate revision unavailable: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    if (state.candidate.revision === null) {
      reasons.push("no verified candidate revision recorded");
    } else if (liveRevision !== state.candidate.revision) {
      reasons.push(`candidate changed after verification (${state.candidate.revision} -> ${liveRevision})`);
    }
    if (!state.evidence.verifier_receipt) {
      reasons.push("missing verifier receipt");
    } else {
      const raw = await this.#store.readReceipt(state.run_id, state.evidence.verifier_receipt) as VerifierReceipt;
      if (raw.candidate_revision_after !== liveRevision) {
        reasons.push(
          `verifier receipt bound to ${raw.candidate_revision_after}, live candidate is ${liveRevision}`,
        );
      }
      if (!raw.ok) {
        reasons.push("verifier receipt is red");
      }
    }
    return { eligible: reasons.length === 0, liveRevision, staleReasons: reasons };
  }

  /** Status/continuation projection (R5.1); no phase inference outside reducer state. */
  async continuation(state: ImprovementRunState, options: Readonly<{
    worktreeExists?: (path: string) => Promise<boolean>;
  }> = {}): Promise<RunContinuation> {
    const blockers: ContinuationBlocker[] = [];
    let staleEvidence: readonly string[] = [];
    let worktreeHealthy: boolean | null = null;

    if (state.phase !== "terminal" && state.phase !== "created" && state.candidate.worktree_path) {
      const exists = options.worktreeExists
        ? await options.worktreeExists(state.candidate.worktree_path)
        : null;
      worktreeHealthy = exists;
      if (exists === false) {
        blockers.push({
          code: "worktree_missing",
          detail: `candidate worktree ${state.candidate.worktree_path} is missing or replaced`,
        });
      }
    }
    if (state.phase === "awaiting_merge" && blockers.length === 0) {
      const eligibility = await this.checkMergeEligibility(state);
      staleEvidence = eligibility.staleReasons;
    }

    const nextAction = blockers.length > 0
      ? "repair or abandon (worktree unhealthy)"
      : continuationAction(state, staleEvidence);
    return {
      run_id: state.run_id,
      phase: state.phase,
      disposition: state.disposition,
      outcome: state.outcome,
      next_action: nextAction,
      blockers,
      stale_evidence: staleEvidence,
      worktree_healthy: worktreeHealthy,
    };
  }

  /** Terminal helper used by runner/CLI failure paths. */
  async terminate(state: ImprovementRunState, input: Readonly<{
    outcome: RunOutcome;
    reason: string;
    failureSignature?: string | null;
    evidence?: Partial<EvidenceRefs>;
  }>): Promise<ImprovementRunState> {
    return this.advance(state, {
      to: "terminal",
      outcome: input.outcome,
      reason: input.reason,
      ...(input.failureSignature !== undefined ? { failure_signature: input.failureSignature } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
    });
  }

  /**
   * R6: identical consecutive failure signatures warn at
   * FAILURE_SIGNATURE_WARN_AT and require an explicit one-use override at
   * FAILURE_SIGNATURE_STOP_AT. Overrides never change recorded receipts.
   */
  async #enforceRepeatedFailurePolicy(
    lineage: readonly ImprovementRunState[],
    overrideReason: string | undefined,
    parentRunId: string,
  ): Promise<void> {
    const terminal = lineage.filter((run) => run.phase === "terminal" && run.failure_signature !== null);
    let consecutive = 0;
    let signature: string | null = null;
    for (let i = terminal.length - 1; i >= 0; i -= 1) {
      const run = terminal[i];
      if (!run || run.failure_signature === null) break;
      if (signature === null) {
        signature = run.failure_signature;
        consecutive = 1;
      } else if (run.failure_signature === signature) {
        consecutive += 1;
      } else {
        break;
      }
    }
    if (signature === null) {
      return;
    }
    if (consecutive >= FAILURE_SIGNATURE_STOP_AT && !overrideReason) {
      throw new RepeatedFailureStop(
        `failure signature ${signature} repeated ${consecutive}x (threshold ${FAILURE_SIGNATURE_STOP_AT}); `
          + `manual stop — retry requires an explicit --override-reason`,
        signature,
        consecutive,
      );
    }
    if (consecutive >= FAILURE_SIGNATURE_WARN_AT) {
      await this.#store.appendDiagnostic(parentRunId, {
        code: "repeated_failure_warning",
        detail: `failure signature ${signature} repeated ${consecutive}x (warn at ${FAILURE_SIGNATURE_WARN_AT}, stop at ${FAILURE_SIGNATURE_STOP_AT})`,
      });
    }
  }
}

function continuationAction(state: ImprovementRunState, staleEvidence: readonly string[]): string {
  switch (state.phase) {
    case "created":
      return "create candidate worktree";
    case "candidate_ready":
      return "run agent apply";
    case "applying":
      // Completion unknown after interruption: never auto-replay (R5.4).
      return "apply interrupted; inspect worktree then resume (verify) or abandon";
    case "verifying":
      return "run verifier and gates";
    case "awaiting_merge":
      return staleEvidence.length > 0
        ? "evidence stale; re-run verifier and gates before any merge ask"
        : "evidence fresh; may re-ask MergeGate (never auto-merge)";
    case "terminal":
      return `terminal (${state.outcome ?? "unknown"}); inspect or archive`;
    default:
      return "unknown";
  }
}
