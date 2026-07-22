/** One concrete blocker observed during a completed task/run. */
export type BlockerEntry = Readonly<{
  id: string;
  kind:
    | "tool_error"
    | "stuck_loop"
    | "repeated_tool"
    | "exit_code"
    | "timeout"
    | "permission"
    | "verify"
    | "unknown";
  summary: string;
  /** Tool name when applicable. */
  tool?: string;
  /** Path / module / command location if known. */
  location?: string;
  /** Short root-cause hypothesis from wash (not user-facing blame). */
  cause?: string;
  /** Raw snippet (truncated). */
  evidence?: string;
  count?: number;
}>;

export type BlockerLog = Readonly<{
  schema_version: "xio-blocker-log.v1";
  run_id: string;
  created_at: string;
  task_success: boolean;
  failure_reasons: readonly string[];
  blockers: readonly BlockerEntry[];
  tool_error_count: number;
  tool_call_count: number;
}>;

export type RetrospectiveActionTarget = "config" | "xiocode" | "workflow" | "norms" | "unknown";

export type RetrospectiveAction = Readonly<{
  id: string;
  target: RetrospectiveActionTarget;
  title: string;
  detail: string;
  /** Suggested config keys or source paths. */
  touchpoints: readonly string[];
  priority: "high" | "medium" | "low";
}>;

/** Cleaned report for the primary agent / improve queue. */
export type RetrospectiveReport = Readonly<{
  schema_version: "xio-retrospective.v1";
  run_id: string;
  created_at: string;
  title: string;
  executive_summary: string;
  blockers: readonly BlockerEntry[];
  actions: readonly RetrospectiveAction[];
  /** Markdown body for humans / injection. */
  markdown: string;
  /** When true, main agent should prioritize acting on this report. */
  pending_for_main: boolean;
  /** When set, this report is preflight-only (session report is authoritative). */
  superseded_by?: "session";
}>;

export type RetrospectiveConfig = Readonly<{
  /** Master switch. Default true when evolve is enabled. */
  enabled: boolean;
  /** Skip runs with zero tool calls (trivial Q&A). Default true. */
  skipTrivial: boolean;
  /** Minimum tool calls to treat as a full task. Default 1. */
  minToolCalls: number;
  /** Inject pending report into the next turn_start. Default true. */
  autoInject: boolean;
  /** Write ImproveGoal drafts under ~/.xiocode/improve/queue. Default true. */
  enqueueImprove: boolean;
  /** Optional LLM polish after deterministic wash (needs callback). Default false. */
  useLlm: boolean;
  /** Run LLM subagent on session_end for authoritative report. Default true. */
  sessionEndSubagent: boolean;
  /** Optional cheap model id for session-end subagent. */
  model?: string;
  /** Session-end subagent timeout ms. Default 45000. */
  sessionEndTimeoutMs: number;
  /**
   * When true, offer strong-confirm write of norms proposals into the target
   * workspace allowlist. Default false (drafts only).
   */
  normsAutoWrite: boolean;
}>;

export const DEFAULT_RETROSPECTIVE_CONFIG: RetrospectiveConfig = {
  enabled: true,
  skipTrivial: true,
  minToolCalls: 1,
  autoInject: true,
  enqueueImprove: true,
  useLlm: false,
  sessionEndSubagent: true,
  sessionEndTimeoutMs: 45_000,
  normsAutoWrite: false,
};
