import type { ExtensionHost } from "./extension-host.ts";
import type {
  ChatMessage,
  ChatToolCall,
  LlmClient,
  ProviderToolChoice,
  ProviderToolChoiceScope,
  TokenUsage,
  ToolExecuteResult,
  TurnEndToolResultSummary,
} from "./types.ts";
import type { DoneContract, DoneContractResult } from "./verify/done-contract.ts";
import type { RuntimeEventEmitter } from "./events/types.ts";
import type { SteerMailbox } from "./steer.ts";
import type { FileWriteQueue } from "./file-write-queue.ts";
import type { LiveConfigView, TurnSnapshot } from "./harness/turn-snapshot.ts";

export type AgentLoopOptions = Readonly<{
  host: ExtensionHost;
  client: LlmClient;
  model: string;
  providerApi?: string;
  /** Provider name for registration lookup (maxTokens / toolChoice). */
  providerName?: string;
  systemPrompt?: string;
  maxTurns?: number;
  doneContract?: DoneContract;
  /** Scrubbed env for done-contract verifier children. */
  doneContractEnv?: NodeJS.ProcessEnv;
  /**
   * Immutable projection for provider-bound messages (value-level secret redaction).
   * SessionHistory / WAL keep raw messages; only the outbound clone is redacted.
   */
  redactOutbound?: <T>(value: T) => T;
  /** Extra turns allowed after a failed done contract to attempt fixes. Default 3. */
  verifyRepairTurns?: number;
  /**
   * Max consecutive identical tool+args before blocking (isError, no execute).
   * Default 3; set 0 to disable.
   */
  repeatToolLimit?: number;
  onAssistantText?: (text: string) => void;
  onAssistantDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolStart?: (call: ChatToolCall) => void;
  onToolEnd?: (call: ChatToolCall, result: ToolExecuteResult) => void;
  signal?: AbortSignal;
  /** When true (default), read/grep/glob/bash run concurrently; write/edit stay serial. */
  parallelToolCalls?: boolean;
  /** Prior session messages for multi-turn continuity. */
  priorMessages?: readonly ChatMessage[];
  /** Hard cap on retained session messages; trim inserts an explicit notice. */
  maxSessionMessages?: number;
  /** Optional override for max_tokens (else model registration). */
  maxTokens?: number;
  toolChoice?: ProviderToolChoice;
  toolChoiceScope?: ProviderToolChoiceScope;
  onCheckpoint?: (checkpoint: AgentLoopCheckpoint) => Promise<void> | void;
  /**
   * Explicit 1-based turn index for trajectory. When omitted, derived as
   * (prior user messages) + 1.
   */
  turnIndex?: number;
  /**
   * Optional RuntimeEvent.v1 bus. When set, agent loop dual-writes core events
   * (turn/text/tool/run) alongside host extension hooks and UI callbacks.
   */
  runtimeEvents?: RuntimeEventEmitter;
  /**
   * Soft/hard steer + follow-up mailbox.
   * Soft: drained at tool-batch end and after a text-only provider step.
   * Follow-up: drained only when the loop would otherwise end (no tools + soft empty).
   * Hard: applied by the outer session after abort (see session.steer).
   * Never injects into the same in-flight provider stream body.
   */
  steerMailbox?: SteerMailbox;
  /**
   * Optional shared realpath write queue. When omitted, a per-batch queue is used
   * so same-path write/edit still serialize within the batch.
   */
  fileWriteQueue?: FileWriteQueue;
  /**
   * Live config getters for per-provider-request TurnSnapshot.
   * When set (default path from session), each provider call freezes a snapshot
   * so mid-request live model/tools changes cannot mutate the in-flight request.
   * When omitted, a snapshot is built once from static options at first request
   * and reused for the rest of the loop (rollback / unit-test path).
   */
  getLiveConfig?: () => LiveConfigView;
  /**
   * When true (default), rebuild TurnSnapshot from getLiveConfig (or static options)
   * before every provider request. When false, freeze once at first request.
   */
  turnSnapshot?: boolean;
  /**
   * When true, start tool execution as soon as complete tool_calls arrive on the
   * provider stream (overlap with remaining stream events). Default false —
   * keep today's post-completion batch.
   */
  streamingTools?: boolean;
  /**
   * Per tool_result character budget before spill-to-disk. When unset, budget
   * application is skipped (caller opts in via session/config).
   */
  toolResultMaxChars?: number;
  /** Spill directory for oversized tool bodies (run `tool-results/` preferred). */
  toolResultSpillDir?: string;
  /**
   * Microcompact: keep newest N tool rounds intact; truncate older tool bodies.
   * Default 4 when toolResultMaxChars is set; 0 disables.
   */
  toolResultKeepRounds?: number;
  /** Test/telemetry hook: observe each frozen snapshot. */
  onTurnSnapshot?: (snapshot: TurnSnapshot) => void;
}>;

export type AgentLoopCheckpoint = Readonly<{
  phase: "turn_started" | "awaiting_provider" | "tool_batch_running" | "turn_complete";
  messages: readonly ChatMessage[];
  pendingTools?: readonly Readonly<{ id: string; name: string }>[];
}>;

export type AgentLoopResult = Readonly<{
  messages: readonly ChatMessage[];
  finalText: string;
  doneContract?: DoneContractResult;
  success: boolean;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  usage: TokenUsage;
  cancelled?: boolean;
  /** When cancelled by hard steer, the steer text to continue with (session applies). */
  hardSteerText?: string;
}>;

export type SegmentResult = Readonly<{
  turns: number;
  finalText: string;
  toolCalls: number;
  toolErrors: number;
  usages: readonly TokenUsage[];
  cancelled?: boolean;
  toolResults: readonly TurnEndToolResultSummary[];
}>;

export type LoopProgress = SegmentResult & Readonly<{
  doneContract?: DoneContractResult;
}>;

/** Mutable collector for tool results within one user-prompt agent loop. */
export type TurnToolCollector = {
  results: TurnEndToolResultSummary[];
};
