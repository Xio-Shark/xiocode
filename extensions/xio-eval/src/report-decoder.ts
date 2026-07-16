import type { EvalReport } from "./types.ts";

export function decodeEvalReportContract(value: unknown): EvalReport {
  const report = asRecord(value, "eval report");
  if (report.schema_version !== "xio-eval-report.v1") {
    throw new Error(`unsupported eval report schema: ${String(report.schema_version)}`);
  }
  assertString(report.eval_id, "eval report eval_id");
  assertString(report.series_id, "eval report series_id");
  assertString(report.created_at, "eval report created_at");
  assertOneOf(report.mode, ["preflight", "smoke", "compare"], "eval report mode");
  assertOneOf(report.status, ["PASS", "PASS_WITH_CONCERNS", "FAIL", "INFRA_ERROR"], "eval report status");
  assertSuite(report.suite);
  assertArray(report.candidates, "eval report candidates").forEach(assertCandidate);
  assertNumberRecord(report.paired_deltas, "eval report paired_deltas");
  assertStringArray(report.concerns, "eval report concerns");
  assertStringArray(report.errors, "eval report errors");
  if (report.performance !== undefined) assertPerformance(report.performance);
  if (report.awareness !== undefined) assertAwareness(report.awareness);
  if (report.private_join !== undefined) assertPrivateJoin(report.private_join);
  if (report.gate !== undefined) assertGate(report.gate);
  return value as EvalReport;
}

function assertPerformance(value: unknown): void {
  const section = asRecord(value, "eval report performance");
  if (section.schema_version !== "xio-eval-performance.v1") {
    throw new Error(`unsupported performance schema: ${String(section.schema_version)}`);
  }
  assertNullableString(section.before_bench_id, "performance.before_bench_id");
  assertNullableString(section.candidate_bench_id, "performance.candidate_bench_id");
  assertStringArray(section.hard_regressions, "performance.hard_regressions");
  assertStringArray(section.soft_regressions, "performance.soft_regressions");
  const deltas = asRecord(section.deltas, "performance.deltas");
  for (const [key, item] of Object.entries(deltas)) {
    const delta = asRecord(item, `performance.deltas.${key}`);
    for (const field of [
      "before_p50_ms", "candidate_p50_ms", "before_p95_ms", "candidate_p95_ms", "delta_p50_ms", "delta_p95_ms",
    ]) {
      assertNullableNonNegativeOrSignedNumber(delta[field], `performance.deltas.${key}.${field}`);
    }
  }
  if (section.resource !== undefined) {
    const resource = asRecord(section.resource, "performance.resource");
    for (const field of [
      "before_rss_bytes", "candidate_rss_bytes", "delta_rss_bytes",
      "before_cpu_user_ms", "candidate_cpu_user_ms", "delta_cpu_user_ms",
      "before_cache_tokens", "candidate_cache_tokens", "delta_cache_tokens",
      "before_cost_usd", "candidate_cost_usd", "delta_cost_usd",
    ]) {
      assertNullableNonNegativeOrSignedNumber(resource[field], `performance.resource.${field}`);
    }
  }
}

function assertAwareness(value: unknown): void {
  const section = asRecord(value, "eval report awareness");
  if (section.schema_version !== "xio-eval-awareness.v1") {
    throw new Error(`unsupported awareness schema: ${String(section.schema_version)}`);
  }
  for (const field of ["evidence_coverage", "overlap", "task_resolution"]) {
    assertNullableNonNegativeNumber(section[field], `awareness.${field}`);
  }
  assertStringArray(section.gaps, "awareness.gaps");
}

function assertPrivateJoin(value: unknown): void {
  const section = asRecord(value, "eval report private_join");
  if (section.schema_version !== "xio-eval-private-join.v1") {
    throw new Error(`unsupported private_join schema: ${String(section.schema_version)}`);
  }
  assertBoolean(section.all_fixed, "private_join.all_fixed");
  if (section.auto_merge_authorized !== false) {
    throw new Error("private_join.auto_merge_authorized must be false");
  }
  for (const item of assertArray(section.cases, "private_join.cases")) {
    const row = asRecord(item, "private_join case");
    assertString(row.case_id, "private_join case.case_id");
    assertString(row.family, "private_join case.family");
    assertString(row.status, "private_join case.status");
  }
}

function assertGate(value: unknown): void {
  const section = asRecord(value, "eval report gate");
  if (section.schema_version !== "xio-eval-gate.v1") {
    throw new Error(`unsupported gate schema: ${String(section.schema_version)}`);
  }
  assertString(section.manifest_id, "gate.manifest_id");
  assertString(section.manifest_version, "gate.manifest_version");
  const axes = asRecord(section.axes, "gate.axes");
  for (const [key, status] of Object.entries(axes)) {
    assertOneOf(status, ["pass", "fail", "concern", "infra", "skipped"], `gate.axes.${key}`);
  }
}

function assertNullableNonNegativeOrSignedNumber(value: unknown, label: string): void {
  if (value !== null) {
    assertNumber(value, label);
  }
}

function assertSuite(value: unknown): void {
  const suite = asRecord(value, "eval report suite");
  for (const field of ["suite_id", "suite_version", "suite_sha", "evaluator_sha"]) {
    assertString(suite[field], `eval report suite ${field}`);
  }
}

function assertCandidate(value: unknown): void {
  const candidate = asRecord(value, "candidate summary");
  assertString(candidate.label, "candidate label");
  assertString(candidate.candidate_revision, "candidate revision");
  for (const field of ["resolved_rate", "resolved", "attempted", "infra_errors"]) {
    assertNonNegativeNumber(candidate[field], `candidate ${field}`);
  }
  assertBoolean(candidate.safety_ok, "candidate safety_ok");
  assertArray(candidate.trials, "candidate trials").forEach(assertTrial);
}

function assertTrial(value: unknown): void {
  const trial = asRecord(value, "trial");
  if (trial.schema_version !== "xio-eval-trial.v1") {
    throw new Error(`unsupported trial schema: ${String(trial.schema_version)}`);
  }
  assertTrialIdentity(trial.identity);
  assertEnvironment(trial.environment);
  assertOutcome(trial.outcome);
  assertSafety(trial.safety);
  assertEfficiency(trial.efficiency);
  assertUsage(trial.usage);
  assertEvidence(trial.evidence);
  if (trial.awareness !== undefined) {
    const awareness = asRecord(trial.awareness, "trial awareness");
    assertNullableNonNegativeNumber(awareness.evidence_coverage, "trial awareness.evidence_coverage");
    assertNullableNonNegativeNumber(awareness.overlap, "trial awareness.overlap");
  }
}

function assertTrialIdentity(value: unknown): void {
  const identity = asRecord(value, "trial identity");
  for (const field of [
    "suite_id", "suite_version", "suite_sha", "evaluator_sha", "fixture_sha",
    "prompt_sha", "grader_sha", "oracle_sha", "eval_id", "series_id", "case_id",
    "family", "candidate_revision", "candidate_label",
  ]) {
    assertString(identity[field], `trial identity ${field}`);
  }
  assertNullableString(identity.system_prompt_sha, "trial identity system_prompt_sha");
}

function assertEnvironment(value: unknown): void {
  const environment = asRecord(value, "trial environment");
  assertNullableString(environment.provider, "trial environment provider");
  assertNullableString(environment.exact_model_id, "trial environment exact_model_id");
  asRecord(environment.inference_settings, "trial environment inference_settings");
  for (const field of ["node", "os", "arch"]) {
    assertString(environment[field], `trial environment ${field}`);
  }
  assertNonNegativeNumber(environment.turn_budget, "trial environment turn_budget");
  assertNonNegativeNumber(environment.timeout_ms, "trial environment timeout_ms");
  assertNullableString(environment.price_table_version, "trial environment price_table_version");
}

function assertOutcome(value: unknown): void {
  const outcome = asRecord(value, "trial outcome");
  assertOneOf(outcome.status, ["resolved", "agent_failure", "safety_failure", "infra_error"], "trial outcome status");
  for (const field of ["task_resolved", "f2p", "p2p", "typecheck"]) {
    assertBoolean(outcome[field], `trial outcome ${field}`);
  }
}

function assertSafety(value: unknown): void {
  const safety = asRecord(value, "trial safety");
  for (const field of [
    "main_unchanged", "forbidden_files_unchanged", "canary_unchanged",
    "hidden_grader_unexposed", "merge_policy_ok", "secret_redaction_ok",
  ]) {
    assertBoolean(safety[field], `trial safety ${field}`);
  }
  if (safety.host_isolation !== "unsupported") {
    throw new Error("trial safety host_isolation must be unsupported");
  }
}

function assertEfficiency(value: unknown): void {
  const efficiency = asRecord(value, "trial efficiency");
  for (const field of ["wall_ms", "agent_ms", "grader_ms", "turns", "tool_calls", "tool_errors"]) {
    assertNonNegativeNumber(efficiency[field], `trial efficiency ${field}`);
  }
}

function assertUsage(value: unknown): void {
  const usage = asRecord(value, "trial usage");
  for (const field of [
    "input_tokens", "output_tokens", "cache_tokens", "reasoning_tokens", "estimated_cost_usd",
  ]) {
    assertNullableNonNegativeNumber(usage[field], `trial usage ${field}`);
  }
}

function assertEvidence(value: unknown): void {
  const evidence = asRecord(value, "trial evidence");
  assertNullableString(evidence.run_id, "trial evidence run_id");
  assertNullableString(evidence.trajectory_path, "trial evidence trajectory_path");
  assertString(evidence.patch_summary, "trial evidence patch_summary");
  for (const field of ["logs", "concerns", "infra_errors", "irreversible_side_effects"]) {
    assertStringArray(evidence[field], `trial evidence ${field}`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function assertStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must contain only strings`);
  }
}

function assertNumberRecord(value: unknown, label: string): void {
  const record = asRecord(value, label);
  for (const [key, item] of Object.entries(record)) {
    assertNumber(item, `${label}.${key}`);
  }
}

function assertOneOf(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function assertString(value: unknown, label: string): void {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
}

function assertNullableString(value: unknown, label: string): void {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${label} must be a string or null`);
  }
}

function assertBoolean(value: unknown, label: string): void {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}

function assertNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

function assertNonNegativeNumber(value: unknown, label: string): void {
  assertNumber(value, label);
  if ((value as number) < 0) {
    throw new Error(`${label} must be non-negative`);
  }
}

function assertNullableNonNegativeNumber(value: unknown, label: string): void {
  if (value !== null) {
    assertNonNegativeNumber(value, label);
  }
}
