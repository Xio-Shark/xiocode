/**
 * Versioned agent tape for ScriptedLlmClient.
 * Drives the real agent loop without network calls.
 */

export const AGENT_TAPE_SCHEMA_VERSION = "xio-agent-tape.v1" as const;

export type TapeDeltaStep = Readonly<{
  type: "delta";
  channel: "text" | "thinking";
  chunks: readonly string[];
}>;

export type TapeToolCallStep = Readonly<{
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}>;

export type TapeUsageStep = Readonly<{
  type: "usage";
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheTokens?: number | null;
  reasoningTokens?: number | null;
}>;

export type TapeErrorStep = Readonly<{
  type: "error";
  class: string;
  message?: string;
}>;

export type TapeHangStep = Readonly<{
  type: "hang";
  /** Delay before continuing (ms). 0 still yields a hang checkpoint for barriers. */
  ms: number;
}>;

export type TapeBarrierStep = Readonly<{
  type: "barrier";
  id: string;
}>;

/** Explicit completion marker; optional — end of step list also completes. */
export type TapeDoneStep = Readonly<{
  type: "done";
}>;

/**
 * One provider request (one agent-loop "inner turn").
 * After tool_call steps the loop will execute tools and call the client again;
 * the next entry in `turns` is consumed then.
 */
export type TapeTurn = Readonly<{
  steps: readonly TapeStep[];
}>;

export type TapeStep =
  | TapeDeltaStep
  | TapeToolCallStep
  | TapeUsageStep
  | TapeErrorStep
  | TapeHangStep
  | TapeBarrierStep
  | TapeDoneStep;

export type AgentTapeV1 = Readonly<{
  schema_version: typeof AGENT_TAPE_SCHEMA_VERSION;
  name: string;
  /** One entry per provider completion the agent loop will request. */
  turns: readonly TapeTurn[];
}>;

export type ScriptedBarrierWaiter = (id: string) => Promise<void> | void;
