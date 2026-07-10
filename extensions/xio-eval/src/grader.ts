import path from "node:path";

import { spawnCommand } from "./process.ts";

import type { GraderResult, LoadedFixture } from "./types.ts";

const RESULT_MARKER = "XIO_EVAL_GRADER=";

export async function gradeWorkspace(options: Readonly<{
  trustedRoot: string;
  workspace: string;
  fixture: LoadedFixture;
}>): Promise<GraderResult> {
  const entry = path.join(options.trustedRoot, "extensions", "xio-eval", "src", "grader-child.ts");
  const result = await spawnCommand({
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      entry,
      options.fixture.id,
      options.workspace,
      options.trustedRoot,
    ],
    cwd: options.trustedRoot,
    timeoutMs: options.fixture.grader_timeout_ms,
  });
  if (result.timedOut) {
    return infraResult(`grader timed out after ${options.fixture.grader_timeout_ms}ms`);
  }
  if (result.cleanupError) {
    return infraResult(result.cleanupError);
  }
  if (result.code !== 0) {
    return infraResult(`grader exited with code ${String(result.code)}: ${result.stderr.trim()}`);
  }
  const payload = markerPayload(result.stdout);
  if (!payload) {
    return infraResult(`grader exited without result (code ${String(result.code)}): ${result.stderr.trim()}`);
  }
  try {
    return decodeGraderResult(JSON.parse(payload) as unknown);
  } catch (error) {
    return infraResult(error instanceof Error ? error.message : String(error));
  }
}

function markerPayload(stdout: string): string | undefined {
  return stdout
    .split("\n")
    .findLast((line) => line.startsWith(RESULT_MARKER))
    ?.slice(RESULT_MARKER.length);
}

function decodeGraderResult(value: unknown): GraderResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("grader result must be an object");
  }
  const result = value as Record<string, unknown>;
  if (result.status !== "graded" && result.status !== "infra_error") {
    throw new Error("invalid grader result status");
  }
  for (const field of [
    "task_resolved",
    "f2p",
    "p2p",
    "typecheck",
    "forbidden_files_unchanged",
    "canary_unchanged",
  ]) {
    if (typeof result[field] !== "boolean") {
      throw new Error(`invalid grader result field: ${field}`);
    }
  }
  if (!Array.isArray(result.details) || !result.details.every((item) => typeof item === "string")
    || typeof result.duration_ms !== "number" || !Number.isFinite(result.duration_ms) || result.duration_ms < 0) {
    throw new Error("invalid grader result payload");
  }
  return value as GraderResult;
}

function infraResult(error: string): GraderResult {
  return {
    status: "infra_error",
    task_resolved: false,
    f2p: false,
    p2p: false,
    typecheck: false,
    forbidden_files_unchanged: false,
    canary_unchanged: false,
    duration_ms: 0,
    details: [],
    error,
  };
}
