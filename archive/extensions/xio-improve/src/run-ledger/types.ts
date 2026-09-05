/**
 * Improvement-run ledger schemas (task 07-23-self-improve-evidence-runtime).
 * Machine-owned run state + append-only transition events + evidence receipts.
 * The ledger references existing stores (runs, cases, evals, worktrees) by
 * stable ref/hash only; it never copies trajectories, private cases or prompts.
 */

export const RUN_STATE_SCHEMA = "xio-improve-run.v1" as const;
export const RUN_EVENT_SCHEMA = "xio-improve-event.v1" as const;
export const RECEIPT_SCHEMA = "xio-improve-receipt.v1" as const;

/** Versioned repeated-failure policy (R6): warn at 2, manual stop at 3. */
export const FAILURE_SIGNATURE_WARN_AT = 2 as const;
export const FAILURE_SIGNATURE_STOP_AT = 3 as const;

export type RunPhase =
  | "created"
  | "candidate_ready"
  | "applying"
  | "verifying"
  | "awaiting_merge"
  | "terminal";

export type RunOutcome =
  | "merged"
  | "rejected"
  | "verifier_red"
  | "gate_blocked"
  | "infra_error"
  | "abandoned"
  | "no_changes";

export type RunDisposition = "running" | "await_user" | "done";

export type GoalRef = Readonly<{
  id: string;
  fingerprint: string;
  source: "queue" | "red_test" | "seed" | "external_eval";
  /** Stable ref into the source store (e.g. queue file name), never content. */
  source_ref: string | null;
  title: string;
}>;

export type RepositoryRef = Readonly<{
  repo_id: string;
  common_dir: string;
  base_revision: string;
  baseline_tree: string | null;
}>;

export type CandidateRef = Readonly<{
  worktree_path: string | null;
  branch: string | null;
  /** candidateRevision() identity; null until first computed. */
  revision: string | null;
  /** Worktree session facts needed to rebuild MergeGate on resume. */
  base_ref: string | null;
  baseline_tree: string | null;
}>;

export type EvidenceRefs = Readonly<{
  verifier_receipt: string | null;
  private_case_id: string | null;
  private_status: string | null;
  eval_id: string | null;
  capability_status: string | null;
  merge_receipt: string | null;
}>;

export type ImprovementRunState = Readonly<{
  schema: typeof RUN_STATE_SCHEMA;
  run_id: string;
  revision: number;
  goal: GoalRef;
  attempt: number;
  parent_run_id: string | null;
  repository: RepositoryRef;
  candidate: CandidateRef;
  phase: RunPhase;
  disposition: RunDisposition;
  outcome: RunOutcome | null;
  failure_signature: string | null;
  evidence: EvidenceRefs;
  created_at: string;
  updated_at: string;
}>;

export type RunEventKind = "transition" | "override" | "note";

export type ImprovementRunEvent = Readonly<{
  schema: typeof RUN_EVENT_SCHEMA;
  run_id: string;
  /** State revision after applying this event; strictly monotonic. */
  state_revision: number;
  kind: RunEventKind;
  from: RunPhase;
  to: RunPhase;
  outcome: RunOutcome | null;
  /** Machine reason code, e.g. claim, worktree_created, stale_candidate. */
  reason: string;
  candidate_revision: string | null;
  evidence_refs: readonly string[];
  at: string;
}>;

export type VerifierReceipt = Readonly<{
  schema: typeof RECEIPT_SCHEMA;
  kind: "verifier";
  run_id: string;
  state_revision: number;
  candidate_revision_before: string;
  candidate_revision_after: string;
  commands: readonly string[];
  ok: boolean;
  exit_code: number;
  /** sha256 of the bounded, redacted output; output itself is not copied. */
  output_hash: string;
  started_at: string;
  ended_at: string;
  stale_reasons: readonly string[];
}>;

export type MergeReceipt = Readonly<{
  schema: typeof RECEIPT_SCHEMA;
  kind: "merge";
  run_id: string;
  state_revision: number;
  candidate_revision: string;
  asked: boolean;
  approved: boolean | null;
  merged: boolean | null;
  detail: string;
  at: string;
}>;

export type LedgerReceipt = VerifierReceipt | MergeReceipt;

/** Input for one committed transition; the reducer is the only phase owner. */
export type TransitionInput = Readonly<{
  to: RunPhase;
  outcome?: RunOutcome;
  reason: string;
  kind?: RunEventKind;
  candidate?: Partial<CandidateRef>;
  evidence?: Partial<EvidenceRefs>;
  failure_signature?: string | null;
  evidence_refs?: readonly string[];
  at?: string;
}>;

export type ContinuationBlocker = Readonly<{
  code: string;
  detail: string;
}>;

/** Machine-readable status/continuation projection (R5). */
export type RunContinuation = Readonly<{
  run_id: string;
  phase: RunPhase;
  disposition: RunDisposition;
  outcome: RunOutcome | null;
  next_action: string;
  blockers: readonly ContinuationBlocker[];
  stale_evidence: readonly string[];
  worktree_healthy: boolean | null;
}>;

export class LedgerDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerDecodeError";
  }
}

const PHASES: readonly RunPhase[] = [
  "created",
  "candidate_ready",
  "applying",
  "verifying",
  "awaiting_merge",
  "terminal",
];

const OUTCOMES: readonly RunOutcome[] = [
  "merged",
  "rejected",
  "verifier_red",
  "gate_blocked",
  "infra_error",
  "abandoned",
  "no_changes",
];

function fail(context: string, detail: string): never {
  throw new LedgerDecodeError(`${context}: ${detail}`);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(context, "expected object");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string") fail(context, "expected string");
  return value;
}

function asNullableString(value: unknown, context: string): string | null {
  if (value === null) return null;
  return asString(value, context);
}

function asNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(context, "expected finite number");
  return value;
}

function asPhase(value: unknown, context: string): RunPhase {
  const raw = asString(value, context);
  if (!PHASES.includes(raw as RunPhase)) fail(context, `unknown phase "${raw}"`);
  return raw as RunPhase;
}

function asNullableOutcome(value: unknown, context: string): RunOutcome | null {
  if (value === null) return null;
  const raw = asString(value, context);
  if (!OUTCOMES.includes(raw as RunOutcome)) fail(context, `unknown outcome "${raw}"`);
  return raw as RunOutcome;
}

/** Strict decoder: unknown top-level fields and future schemas fail closed. */
export function decodeRunState(value: unknown): ImprovementRunState {
  const root = asRecord(value, "run state");
  if (root.schema !== RUN_STATE_SCHEMA) {
    fail("run state", `unsupported schema "${String(root.schema)}"`);
  }
  const known = new Set([
    "schema", "run_id", "revision", "goal", "attempt", "parent_run_id", "repository",
    "candidate", "phase", "disposition", "outcome", "failure_signature", "evidence",
    "created_at", "updated_at",
  ]);
  for (const key of Object.keys(root)) {
    if (!known.has(key)) fail("run state", `unknown field "${key}"`);
  }
  const goal = asRecord(root.goal, "run state.goal");
  const repository = asRecord(root.repository, "run state.repository");
  const candidate = asRecord(root.candidate, "run state.candidate");
  const evidence = asRecord(root.evidence, "run state.evidence");
  const source = asString(goal.source, "run state.goal.source");
  if (!["queue", "red_test", "seed", "external_eval"].includes(source)) {
    fail("run state.goal.source", `unknown source "${source}"`);
  }
  const disposition = asString(root.disposition, "run state.disposition");
  if (!["running", "await_user", "done"].includes(disposition)) {
    fail("run state.disposition", `unknown disposition "${disposition}"`);
  }
  const revision = asNumber(root.revision, "run state.revision");
  if (!Number.isInteger(revision) || revision < 0) fail("run state.revision", "expected non-negative integer");
  return {
    schema: RUN_STATE_SCHEMA,
    run_id: asString(root.run_id, "run state.run_id"),
    revision,
    goal: {
      id: asString(goal.id, "run state.goal.id"),
      fingerprint: asString(goal.fingerprint, "run state.goal.fingerprint"),
      source: source as GoalRef["source"],
      source_ref: asNullableString(goal.source_ref, "run state.goal.source_ref"),
      title: asString(goal.title, "run state.goal.title"),
    },
    attempt: asNumber(root.attempt, "run state.attempt"),
    parent_run_id: asNullableString(root.parent_run_id, "run state.parent_run_id"),
    repository: {
      repo_id: asString(repository.repo_id, "run state.repository.repo_id"),
      common_dir: asString(repository.common_dir, "run state.repository.common_dir"),
      base_revision: asString(repository.base_revision, "run state.repository.base_revision"),
      baseline_tree: asNullableString(repository.baseline_tree, "run state.repository.baseline_tree"),
    },
    candidate: {
      worktree_path: asNullableString(candidate.worktree_path, "run state.candidate.worktree_path"),
      branch: asNullableString(candidate.branch, "run state.candidate.branch"),
      revision: asNullableString(candidate.revision, "run state.candidate.revision"),
      base_ref: asNullableString(candidate.base_ref ?? null, "run state.candidate.base_ref"),
      baseline_tree: asNullableString(candidate.baseline_tree ?? null, "run state.candidate.baseline_tree"),
    },
    phase: asPhase(root.phase, "run state.phase"),
    disposition: disposition as RunDisposition,
    outcome: asNullableOutcome(root.outcome, "run state.outcome"),
    failure_signature: asNullableString(root.failure_signature, "run state.failure_signature"),
    evidence: {
      verifier_receipt: asNullableString(evidence.verifier_receipt, "run state.evidence.verifier_receipt"),
      private_case_id: asNullableString(evidence.private_case_id, "run state.evidence.private_case_id"),
      private_status: asNullableString(evidence.private_status, "run state.evidence.private_status"),
      eval_id: asNullableString(evidence.eval_id, "run state.evidence.eval_id"),
      capability_status: asNullableString(evidence.capability_status, "run state.evidence.capability_status"),
      merge_receipt: asNullableString(evidence.merge_receipt, "run state.evidence.merge_receipt"),
    },
    created_at: asString(root.created_at, "run state.created_at"),
    updated_at: asString(root.updated_at, "run state.updated_at"),
  };
}

export function decodeRunEvent(value: unknown): ImprovementRunEvent {
  const root = asRecord(value, "run event");
  if (root.schema !== RUN_EVENT_SCHEMA) {
    fail("run event", `unsupported schema "${String(root.schema)}"`);
  }
  const kind = asString(root.kind, "run event.kind");
  if (!["transition", "override", "note"].includes(kind)) {
    fail("run event.kind", `unknown kind "${kind}"`);
  }
  const refs = root.evidence_refs;
  if (!Array.isArray(refs) || refs.some((entry) => typeof entry !== "string")) {
    fail("run event.evidence_refs", "expected string array");
  }
  const stateRevision = asNumber(root.state_revision, "run event.state_revision");
  if (!Number.isInteger(stateRevision) || stateRevision < 1) {
    fail("run event.state_revision", "expected positive integer");
  }
  return {
    schema: RUN_EVENT_SCHEMA,
    run_id: asString(root.run_id, "run event.run_id"),
    state_revision: stateRevision,
    kind: kind as RunEventKind,
    from: asPhase(root.from, "run event.from"),
    to: asPhase(root.to, "run event.to"),
    outcome: asNullableOutcome(root.outcome ?? null, "run event.outcome"),
    reason: asString(root.reason, "run event.reason"),
    candidate_revision: asNullableString(root.candidate_revision ?? null, "run event.candidate_revision"),
    evidence_refs: refs as readonly string[],
    at: asString(root.at, "run event.at"),
  };
}
