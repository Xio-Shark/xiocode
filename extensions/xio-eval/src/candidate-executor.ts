import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { spawnCommand } from "./process.ts";
import { emptyUsage } from "./types.ts";

import type { CandidateExecutorOptions, CandidateInput, CandidateResult, UsageMetrics } from "./types.ts";

const RESULT_MARKER = "XIO_EVAL_RESULT=";

export type ExecutedCandidate = Readonly<{
  result: CandidateResult;
  stdout: string;
  stderr: string;
}>;

export async function executeCandidate(options: CandidateExecutorOptions): Promise<ExecutedCandidate> {
  const trialHome = path.join(options.trial_root, "home");
  await mkdir(path.join(trialHome, ".xiocode"), { recursive: true });
  if (options.mode === "real") {
    const configError = await copyUserConfig(trialHome, options.env ?? process.env);
    if (configError) {
      return { result: infraResult(configError), stdout: "", stderr: "" };
    }
  }
  const inputPath = path.join(options.trial_root, "candidate-input.json");
  await writeFile(inputPath, `${JSON.stringify(createCandidateInput(options), null, 2)}\n`, "utf8");
  const entry = path.join(options.trusted_root, "extensions", "xio-eval", "src", "candidate-child.ts");
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
    env: { ...(options.env ?? process.env), HOME: trialHome, XIO_HOME: path.join(trialHome, ".xiocode") },
    timeoutMs: options.fixture.wall_timeout_ms,
  });
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
  return options.mode === "stub"
    ? { ...common, mode: "stub", oracle_files: options.fixture.oracle_files }
    : { ...common, mode: "real" };
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

async function copyUserConfig(trialHome: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const home = env.HOME ?? os.homedir();
  const configured = env.XIO_CONFIG ?? path.join(home, ".xiocode", "config.toml");
  const source = path.resolve(expandHome(configured, home));
  let content: string;
  try {
    content = await readFile(source, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return code === "ENOENT" ? `missing XioCode config: ${source}` : `cannot read XioCode config: ${String(error)}`;
  }
  await writeFile(path.join(trialHome, ".xiocode", "config.toml"), content, "utf8");
  return undefined;
}

function expandHome(value: string, home: string): string {
  if (value === "~") {
    return home;
  }
  return value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
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
