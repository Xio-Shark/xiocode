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
