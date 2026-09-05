import {
  RUN_EVENT_SCHEMA,
  type ImprovementRunEvent,
  type ImprovementRunState,
  type RunDisposition,
  type RunOutcome,
  type RunPhase,
  type TransitionInput,
} from "./types.ts";

/**
 * Single transition owner for improvement runs (R2). CLI/runner/status must
 * never infer phase locally; every committed change goes through this table.
 */

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

/** Forward edges; any nonterminal phase may also fail to `terminal`. */
const FORWARD_EDGES: Readonly<Record<RunPhase, readonly RunPhase[]>> = {
  created: ["candidate_ready"],
  candidate_ready: ["applying"],
  applying: ["verifying"],
  verifying: ["awaiting_merge"],
  // Stale evidence retreats to verifying instead of asking with old receipts.
  awaiting_merge: ["verifying"],
  terminal: [],
};

/** Outcomes allowed only from awaiting_merge (user decision). */
const MERGE_OUTCOMES: readonly RunOutcome[] = ["merged", "rejected"];

/** Failure/exit outcomes allowed from any nonterminal phase. */
const FAILURE_OUTCOMES: readonly RunOutcome[] = [
  "verifier_red",
  "gate_blocked",
  "infra_error",
  "abandoned",
  "no_changes",
];

function dispositionFor(phase: RunPhase): RunDisposition {
  if (phase === "terminal") return "done";
  if (phase === "awaiting_merge") return "await_user";
  return "running";
}

export function assertTransitionAllowed(state: ImprovementRunState, input: TransitionInput): void {
  // Audit-only events (override/note) keep the phase and bump revision only.
  if ((input.kind === "override" || input.kind === "note") && input.to === state.phase && !input.outcome) {
    if (state.phase === "terminal" && input.kind === "override") {
      throw new InvalidTransitionError("override cannot be recorded on a terminal run");
    }
    return;
  }
  if (state.phase === "terminal") {
    throw new InvalidTransitionError(
      `run ${state.run_id} is terminal (${state.outcome ?? "unknown"}); retry creates a new attempt`,
    );
  }
  if (input.to === "terminal") {
    if (!input.outcome) {
      throw new InvalidTransitionError("terminal transition requires an outcome");
    }
    if (MERGE_OUTCOMES.includes(input.outcome)) {
      if (state.phase !== "awaiting_merge") {
        throw new InvalidTransitionError(
          `outcome "${input.outcome}" is only valid from awaiting_merge (current: ${state.phase})`,
        );
      }
      return;
    }
    if (!FAILURE_OUTCOMES.includes(input.outcome)) {
      throw new InvalidTransitionError(`unknown terminal outcome "${input.outcome}"`);
    }
    return;
  }
  if (input.outcome) {
    throw new InvalidTransitionError("outcome is only valid on terminal transitions");
  }
  if (!FORWARD_EDGES[state.phase].includes(input.to)) {
    throw new InvalidTransitionError(
      `transition ${state.phase} -> ${input.to} is not allowed`,
    );
  }
}

export type ReducedTransition = Readonly<{
  state: ImprovementRunState;
  event: ImprovementRunEvent;
}>;

/**
 * Pure reducer: validates the edge, bumps revision exactly once, and emits the
 * matching audit event. Persistence commits event first (WAL), then state.
 */
export function reduceTransition(
  state: ImprovementRunState,
  input: TransitionInput,
): ReducedTransition {
  assertTransitionAllowed(state, input);
  const at = input.at ?? new Date().toISOString();
  const revision = state.revision + 1;
  const candidate = { ...state.candidate, ...(input.candidate ?? {}) };
  const evidence = { ...state.evidence, ...(input.evidence ?? {}) };
  const next: ImprovementRunState = {
    ...state,
    revision,
    candidate,
    evidence,
    phase: input.to,
    disposition: dispositionFor(input.to),
    // Audit-only events on a terminal run must not erase the recorded outcome.
    outcome: input.to === "terminal" ? input.outcome ?? state.outcome : null,
    failure_signature: input.failure_signature !== undefined
      ? input.failure_signature
      : state.failure_signature,
    updated_at: at,
  };
  const event: ImprovementRunEvent = {
    schema: RUN_EVENT_SCHEMA,
    run_id: state.run_id,
    state_revision: revision,
    kind: input.kind ?? "transition",
    from: state.phase,
    to: input.to,
    outcome: input.to === "terminal" ? input.outcome ?? state.outcome : null,
    reason: input.reason,
    candidate_revision: candidate.revision,
    evidence_refs: input.evidence_refs ?? [],
    at,
  };
  return { state: next, event };
}

/**
 * WAL replay: events with revision > state.revision are committed intents that
 * did not reach state.json (crash between append and atomic replace). Replay
 * settles them deterministically; gaps or replay failures must fail closed.
 */
export function replayPendingEvents(
  state: ImprovementRunState,
  events: readonly ImprovementRunEvent[],
): ImprovementRunState {
  let current = state;
  for (const event of events) {
    if (event.state_revision <= current.revision) {
      continue;
    }
    if (event.state_revision !== current.revision + 1) {
      throw new InvalidTransitionError(
        `event revision gap for run ${state.run_id}: state at ${current.revision}, event at ${event.state_revision}`,
      );
    }
    const { state: next } = reduceTransition(current, {
      to: event.to,
      ...(event.outcome ? { outcome: event.outcome } : {}),
      reason: event.reason,
      kind: event.kind,
      candidate: { revision: event.candidate_revision },
      evidence_refs: event.evidence_refs,
      at: event.at,
    });
    current = next;
  }
  return current;
}
