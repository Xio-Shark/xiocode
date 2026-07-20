/**
 * RuntimeEvent.v1 — shared agent-run event envelope.
 *
 * Seq is monotonic **per run_id** (starts at 0). Subagents use their own run_id;
 * parent_run_id may appear in payload later.
 *
 * Session WAL remains a separate recovery journal — do not dump all RuntimeEvents into WAL.
 */

export const RUNTIME_EVENT_SCHEMA_VERSION = "xio-runtime-event.v1" as const;

/** Namespaced event catalog (minimum product set + steering placeholders). */
export const RUNTIME_EVENT_NAMES = [
  "run.start",
  "run.end",
  "turn.start",
  "turn.end",
  "text.delta",
  "thinking.delta",
  "tool.call",
  "tool.result",
  "tool.error",
  "provider.request",
  "provider.first_token",
  "provider.done",
  "error",
  "cancel",
  "steer.requested",
  "steer.applied",
  /** Harness phase: idle | turn | compaction | retry */
  "harness.phase",
  /** Messages persisted; pending listener writes may still be in flight. */
  "harness.save_point",
  /** Structural op finished and tracked settles drained. */
  "harness.settled",
] as const;

export type RuntimeEventName = (typeof RUNTIME_EVENT_NAMES)[number];

export type RuntimeEventV1 = Readonly<{
  schema_version: typeof RUNTIME_EVENT_SCHEMA_VERSION;
  /** Monotonic per run_id; starts at 0. */
  seq: number;
  timestamp: string;
  session_id: string;
  run_id: string;
  turn_id: string | null;
  event: RuntimeEventName;
  payload: Readonly<Record<string, unknown>>;
}>;

export type RuntimeEventIds = Readonly<{
  session_id: string;
  run_id: string;
  turn_id?: string | null;
}>;

export type RuntimeEventHandler = (event: RuntimeEventV1) => void | Promise<void>;

export type RuntimeEventEmitter = Readonly<{
  /** Emit a versioned envelope; returns the event after redaction. */
  emit: (
    event: RuntimeEventName,
    payload?: Readonly<Record<string, unknown>>,
    ids?: Partial<RuntimeEventIds>,
  ) => RuntimeEventV1;
  subscribe: (handler: RuntimeEventHandler) => () => void;
  /** Current run scope (mutable turn_id). */
  getIds: () => RuntimeEventIds & { turn_id: string | null };
  setTurnId: (turnId: string | null) => void;
  /** Next seq that will be assigned (for tests). */
  peekSeq: () => number;
  /**
   * Await all in-flight async subscribe handlers.
   * Used by harness waitForIdle / settle so listeners cannot outlive the run.
   */
  flushPending: () => Promise<void>;
}>;
