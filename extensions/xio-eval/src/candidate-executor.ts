import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertArtifactsOmitSecret } from "./credentialed-env.ts";
import { spawnCommand } from "./process.ts";
import { emptyUsage } from "./types.ts";

import type { CandidateExecutorOptions, CandidateInput, CandidateResult, UsageMetrics } from "./types.ts";

const RESULT_MARKER = "XIO_EVAL_RESULT=";

const REAL_CHILD_ENV_ALLOWLIST = new Set([
  "PATH",
  "PATHEXT",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "TZ",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "SystemRoot",
  "ComSpec",
  "PROCESSOR_ARCHITECTURE",
]);

export type ExecutedCandidate = Readonly<{
  result: CandidateResult;
  stdout: string;
  stderr: string;
}>;

export async function executeCandidate(options: CandidateExecutorOptions): Promise<ExecutedCandidate> {
  const trialHome = path.join(options.trial_root, "home");
  await mkdir(path.join(trialHome, ".xiocode"), { recursive: true });
  let baseChildEnv: NodeJS.ProcessEnv;
  if (options.mode === "real") {
    const configError = await writeTrialConfig(trialHome, options);
    if (configError) {
      return { result: infraResult(configError), stdout: "", stderr: "" };
    }
    const preparedEnv = prepareRealChildEnv(options.child_env, options.secret_for_scan);
    if ("error" in preparedEnv) {
      return { result: infraResult(preparedEnv.error), stdout: "", stderr: "" };
    }
    baseChildEnv = preparedEnv.env;
  } else {
    baseChildEnv = { ...(options.env ?? process.env) };
  }
  const inputPath = path.join(options.trial_root, "candidate-input.json");
  const input = createCandidateInput(options);
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  const entry = path.join(options.trusted_root, "extensions", "xio-eval", "src", "candidate-child.ts");
  const childEnv: NodeJS.ProcessEnv = {
    ...baseChildEnv,
    HOME: trialHome,
    XIO_HOME: path.join(trialHome, ".xiocode"),
    XIO_CONFIG: path.join(trialHome, ".xiocode", "config.toml"),
  };
  // Never expose the host credentials path to the candidate child.
  delete childEnv.XIO_CREDENTIALS;
  const result = await spawnCommand({
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      entry,
      options.candidate_root,
      options.fixture_root,
      trialHome,
      inputPath,
    ],
    cwd: options.trusted_root,
    env: childEnv,
    timeoutMs: options.fixture.wall_timeout_ms,
  });
  if (options.secret_for_scan) {
    const leaks = assertArtifactsOmitSecret(options.secret_for_scan, {
      "candidate-input.json": JSON.stringify(input),
      stdout: result.stdout,
      stderr: result.stderr,
    });
    if (leaks.length > 0) {
      return {
        result: infraResult(leaks.join("; ")),
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
  }
  if (result.cleanupError) {
    return {
      result: infraResult(result.cleanupError),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  if (result.timedOut) {
    return {
      result: {
        ...infraResult(`candidate timed out after ${options.fixture.wall_timeout_ms}ms`),
        status: "timeout",
        agent_ms: result.durationMs,
      },
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return {
    result: decodeCandidateOutput(result.stdout, result.stderr, result.code),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function createCandidateInput(options: CandidateExecutorOptions): CandidateInput {
  const common = {
    schema_version: "xio-eval-candidate-input.v1" as const,
    case_id: options.fixture.id,
    prompt: options.fixture.prompt,
    max_turns: options.fixture.max_turns,
  };
  if (options.mode === "stub") {
    return { ...common, mode: "stub", oracle_files: options.fixture.oracle_files };
  }
  return {
    ...common,
    mode: "real",
    ...(options.pinned_provider ? { provider: options.pinned_provider } : {}),
    ...(options.pinned_model ? { model: options.pinned_model } : {}),
  };
}

async function writeTrialConfig(
  trialHome: string,
  options: CandidateExecutorOptions,
): Promise<string | undefined> {
  if (!options.config_content) {
    return "real eval missing pinned config content from trusted controller";
  }
  if (options.secret_for_scan && options.config_content.includes(options.secret_for_scan)) {
    return "config content unexpectedly contains provider secret";
  }
  await writeFile(path.join(trialHome, ".xiocode", "config.toml"), options.config_content, "utf8");
  return undefined;
}

function prepareRealChildEnv(
  source: NodeJS.ProcessEnv | undefined,
  selectedSecret: string | undefined,
): Readonly<{ env: NodeJS.ProcessEnv }> | Readonly<{ error: string }> {
  if (!source || !selectedSecret) {
    return { error: "real eval missing selected-provider child environment from trusted controller" };
  }
  const selectedKeyEntries = Object.entries(source)
    .filter(([, value]) => value === selectedSecret);
  if (selectedKeyEntries.length !== 1) {
    return { error: "real eval child environment does not identify exactly one selected provider key" };
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && REAL_CHILD_ENV_ALLOWLIST.has(key)) {
      env[key] = value;
    }
  }
  const [apiKeyEnv] = selectedKeyEntries[0]!;
  env[apiKeyEnv] = selectedSecret;
  return { env };
}

function decodeCandidateOutput(stdout: string, stderr: string, exitCode: number | null): CandidateResult {
  const payload = stdout
    .split("\n")
    .findLast((line) => line.startsWith(RESULT_MARKER))
    ?.slice(RESULT_MARKER.length);
  if (!payload) {
    return infraResult(`candidate exited without result (code ${String(exitCode)}): ${stderr.trim()}`);
  }
  try {
    return decodeCandidateResult(JSON.parse(payload) as unknown);
  } catch (error) {
    return infraResult(error instanceof Error ? error.message : String(error));
  }
}

function decodeCandidateResult(value: unknown): CandidateResult {
  const result = asRecord(value, "candidate result");
  if (result.schema_version !== "xio-eval-candidate.v1") {
    throw new Error(`unsupported candidate schema: ${String(result.schema_version)}`);
  }
  if (!["completed", "agent_failure", "infra_error", "timeout"].includes(String(result.status))) {
    throw new Error("invalid candidate status");
  }
  for (const field of ["agent_ms", "turns", "tool_calls", "tool_errors"]) {
    assertNonNegativeNumber(result[field], `candidate ${field}`);
  }
  assertOptionalString(result.worktree_path, "candidate worktree_path");
  assertOptionalString(result.run_id, "candidate run_id");
  assertNullableString(result.provider, "candidate provider");
  assertNullableString(result.model, "candidate model");
  assertNullableString(result.system_prompt_sha, "candidate system_prompt_sha");
  decodeUsage(result.usage);
  return value as CandidateResult;
}

function decodeUsage(value: unknown): UsageMetrics {
  const usage = asRecord(value, "candidate usage");
  for (const field of ["input_tokens", "output_tokens", "cache_tokens", "reasoning_tokens", "estimated_cost_usd"]) {
    const item = usage[field];
    if (item !== null && (typeof item !== "number" || !Number.isFinite(item) || item < 0)) {
      throw new Error(`candidate usage ${field} must be a non-negative number or null`);
    }
  }
  return value as UsageMetrics;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertNonNegativeNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
}

function assertNullableString(value: unknown, label: string): void {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${label} must be a string or null`);
  }
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${label} must be a string or absent`);
  }
}

function infraResult(error: string): CandidateResult {
  return {
    schema_version: "xio-eval-candidate.v1",
    status: "infra_error",
    provider: null,
    model: null,
    agent_ms: 0,
    turns: 0,
    tool_calls: 0,
    tool_errors: 0,
    system_prompt_sha: null,
    usage: emptyUsage(),
    error,
  };
}
