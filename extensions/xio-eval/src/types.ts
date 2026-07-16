export type EvalStatus = "PASS" | "PASS_WITH_CONCERNS" | "FAIL" | "INFRA_ERROR";
export type EvalMode = "preflight" | "smoke" | "compare";
export type FixtureFamily = "local-bug" | "cross-file-contract" | "cli-behavior" | "test-and-repair" | "scope-safety";
export type FixtureVisibility = "dev" | "holdout";
export type CandidateMode = "real" | "stub";

export type UsageMetrics = Readonly<{
  input_tokens: number | null;
  output_tokens: number | null;
  cache_tokens: number | null;
  reasoning_tokens: number | null;
  estimated_cost_usd: number | null;
}>;

export type PriceTable = Readonly<{
  schema_version: "xio-eval-price-table.v1";
  version: string;
  models: Readonly<Record<string, Readonly<{
    input_per_million: number;
    output_per_million: number;
    cache_per_million: number;
    reasoning_per_million: number;
  }>>>;
}>;

export type FixtureGraderConfig =
  | Readonly<{ kind: "clamp"; module: string; exportName: string; edge: readonly [number, number, number, number]; stable: readonly [number, number, number, number] }>
  | Readonly<{ kind: "contract"; producerModule: string; producerExport: string; consumerModule: string; consumerExport: string; enabledText: string; disabledText: string }>
  | Readonly<{ kind: "cli"; entry: string; validArgs: readonly string[]; validStdout: string; invalidArgs: readonly string[]; invalidStderr: string; invalidExitCode: number }>
  | Readonly<{ kind: "parser"; module: string; exportName: string; visibleInput: string; visibleValue: number; stableInput: string; stableValue: number }>
  | Readonly<{ kind: "scope"; module: string; exportName: string; input: string; expected: string }>;

export type TrustedFixture = Readonly<{
  schema_version: "xio-eval-fixture.v1";
  id: string;
  family: FixtureFamily;
  visibility: FixtureVisibility;
  prompt: string;
  public_files: Readonly<Record<string, string>>;
  oracle_files: Readonly<Record<string, string>>;
  grader: FixtureGraderConfig;
  forbidden_paths: readonly string[];
  max_turns: number;
  wall_timeout_ms: number;
  grader_timeout_ms: number;
}>;

export type FixtureIdentity = Readonly<{
  fixture_sha: string;
  prompt_sha: string;
  grader_sha: string;
  oracle_sha: string;
}>;

export type LoadedFixture = TrustedFixture & FixtureIdentity;

export type SuiteIdentity = Readonly<{
  suite_id: string;
  suite_version: string;
  suite_sha: string;
  evaluator_sha: string;
}>;

export type GraderResult = Readonly<{
  status: "graded" | "infra_error";
  task_resolved: boolean;
  f2p: boolean;
  p2p: boolean;
  typecheck: boolean;
  forbidden_files_unchanged: boolean;
  canary_unchanged: boolean;
  duration_ms: number;
  details: readonly string[];
  error?: string;
}>;

export type CandidateResult = Readonly<{
  schema_version: "xio-eval-candidate.v1";
  status: "completed" | "agent_failure" | "infra_error" | "timeout";
  worktree_path?: string;
  run_id?: string;
  provider: string | null;
  model: string | null;
  agent_ms: number;
  turns: number;
  tool_calls: number;
  tool_errors: number;
  system_prompt_sha: string | null;
  usage: UsageMetrics;
  error?: string;
}>;

export type SafetyResult = Readonly<{
  main_unchanged: boolean;
  forbidden_files_unchanged: boolean;
  canary_unchanged: boolean;
  hidden_grader_unexposed: boolean;
  merge_policy_ok: boolean;
  secret_redaction_ok: boolean;
  host_isolation: "unsupported";
}>;

export type TrialIdentity = SuiteIdentity & FixtureIdentity & Readonly<{
  eval_id: string;
  series_id: string;
  case_id: string;
  family: FixtureFamily;
  candidate_revision: string;
  candidate_label: string;
  system_prompt_sha: string | null;
}>;

/** Optional per-trial workspace-awareness metrics (explore brief / perception). */
export type TrialAwarenessMetrics = Readonly<{
  evidence_coverage: number | null;
  overlap: number | null;
}>;

export type TrialReport = Readonly<{
  schema_version: "xio-eval-trial.v1";
  identity: TrialIdentity;
  environment: Readonly<{
    provider: string | null;
    exact_model_id: string | null;
    inference_settings: Readonly<Record<string, unknown>>;
    node: string;
    os: string;
    arch: string;
    turn_budget: number;
    timeout_ms: number;
    price_table_version: string | null;
  }>;
  outcome: Readonly<{
    status: "resolved" | "agent_failure" | "safety_failure" | "infra_error";
    task_resolved: boolean;
    f2p: boolean;
    p2p: boolean;
    typecheck: boolean;
  }>;
  safety: SafetyResult;
  efficiency: Readonly<{
    wall_ms: number;
    agent_ms: number;
    grader_ms: number;
    turns: number;
    tool_calls: number;
    tool_errors: number;
  }>;
  usage: UsageMetrics;
  evidence: Readonly<{
    run_id: string | null;
    trajectory_path: string | null;
    patch_summary: string;
    logs: readonly string[];
    concerns: readonly string[];
    infra_errors: readonly string[];
    irreversible_side_effects: readonly string[];
  }>;
  /** Optional awareness metrics from explore/perception product path. */
  awareness?: TrialAwarenessMetrics;
}>;

export type CandidateSummary = Readonly<{
  label: string;
  candidate_revision: string;
  resolved_rate: number;
  resolved: number;
  attempted: number;
  infra_errors: number;
  safety_ok: boolean;
  trials: readonly TrialReport[];
}>;

export type CandidateInput =
  | Readonly<{
    schema_version: "xio-eval-candidate-input.v1";
    mode: "real";
    case_id: string;
    prompt: string;
    max_turns: number;
    provider?: string;
    model?: string;
  }>
  | Readonly<{
    schema_version: "xio-eval-candidate-input.v1";
    mode: "stub";
    case_id: string;
    prompt: string;
    max_turns: number;
    oracle_files: Readonly<Record<string, string>>;
  }>;

export type PerformanceMetricDelta = Readonly<{
  before_p50_ms: number | null;
  candidate_p50_ms: number | null;
  before_p95_ms: number | null;
  candidate_p95_ms: number | null;
  delta_p50_ms: number | null;
  delta_p95_ms: number | null;
}>;

export type PerformanceResourceDelta = Readonly<{
  before_rss_bytes: number | null;
  candidate_rss_bytes: number | null;
  delta_rss_bytes: number | null;
  before_cpu_user_ms: number | null;
  candidate_cpu_user_ms: number | null;
  delta_cpu_user_ms: number | null;
  before_cache_tokens: number | null;
  candidate_cache_tokens: number | null;
  delta_cache_tokens: number | null;
  before_cost_usd: number | null;
  candidate_cost_usd: number | null;
  delta_cost_usd: number | null;
}>;

export type PerformanceSection = Readonly<{
  schema_version: "xio-eval-performance.v1";
  before_bench_id: string | null;
  candidate_bench_id: string | null;
  deltas: Readonly<Record<string, PerformanceMetricDelta>>;
  resource?: PerformanceResourceDelta;
  hard_regressions: readonly string[];
  soft_regressions: readonly string[];
}>;

export type AwarenessSection = Readonly<{
  schema_version: "xio-eval-awareness.v1";
  evidence_coverage: number | null;
  overlap: number | null;
  task_resolution: number | null;
  gaps: readonly string[];
}>;

export type PrivateJoinCase = Readonly<{
  case_id: string;
  family: string;
  status: string;
}>;

export type PrivateJoinSection = Readonly<{
  schema_version: "xio-eval-private-join.v1";
  cases: readonly PrivateJoinCase[];
  all_fixed: boolean;
  /** Literal false — private join never authorizes auto-merge. */
  auto_merge_authorized: false;
}>;

export type GateAxisStatus = "pass" | "fail" | "concern" | "infra" | "skipped";

export type GateSection = Readonly<{
  schema_version: "xio-eval-gate.v1";
  manifest_id: string;
  manifest_version: string;
  axes: Readonly<Record<string, GateAxisStatus>>;
}>;

export type EvalReport = Readonly<{
  schema_version: "xio-eval-report.v1";
  eval_id: string;
  series_id: string;
  mode: EvalMode;
  status: EvalStatus;
  created_at: string;
  suite: SuiteIdentity;
  candidates: readonly CandidateSummary[];
  paired_deltas: Readonly<Record<string, number>>;
  concerns: readonly string[];
  errors: readonly string[];
  /** Optional multi-axis performance deltas from independent bench reports. */
  performance?: PerformanceSection;
  /** Optional workspace-awareness / coverage metrics. */
  awareness?: AwarenessSection;
  /** Optional private regression join (evidence only; never auto-merge). */
  private_join?: PrivateJoinSection;
  /** Optional gate manifest axis summary. */
  gate?: GateSection;
}>;

export type CandidateExecutorOptions = Readonly<{
  trusted_root: string;
  candidate_root: string;
  fixture_root: string;
  trial_root: string;
  fixture: LoadedFixture;
  mode: CandidateMode;
  env?: NodeJS.ProcessEnv;
  /** Pre-resolved child env (selected-provider allowlist). When set, skips parent env passthrough. */
  child_env?: NodeJS.ProcessEnv;
  /** Pinned config.toml content for real mode (already mutated; no secrets). */
  config_content?: string;
  pinned_provider?: string;
  pinned_model?: string;
  secret_for_scan?: string;
}>;

export type EvalRunOptions = Readonly<{
  trusted_root: string;
  candidate_root?: string;
  before_root?: string;
  candidate_mode?: CandidateMode;
  /** Exact `provider/model` identity for real runs. */
  model?: string;
  /** Fixed trial repeats per fixture (default 1). */
  repeat?: number;
  eval_root?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  case_ids?: readonly string[];
  price_table_path?: string;
  /** Multi-axis gate manifest path (defaults when perf/private flags used). */
  gate_manifest_path?: string;
  /** Independent before/candidate `xio bench` report.json paths. */
  perf_before_path?: string;
  perf_candidate_path?: string;
  /** Private regression case ids to join (evidence only; never auto-merge). */
  private_case_ids?: readonly string[];
}>;

export function emptyUsage(): UsageMetrics {
  return {
    input_tokens: null,
    output_tokens: null,
    cache_tokens: null,
    reasoning_tokens: null,
    estimated_cost_usd: null,
  };
}

export { decodeEvalReportContract as decodeEvalReport } from "./report-decoder.ts";
