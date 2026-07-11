import { SecretRedactor } from "../../extensions/xio-evolve/src/secret-redactor.ts";

import type {
  CaptureResult,
  PrivateRegressionCompare,
  PrivateRegressionPreflight,
} from "../../extensions/xio-regress/src/types.ts";

const OUTPUT_REDACTOR = new SecretRedactor();

export function writeCapture(options: Readonly<{
  write: (chunk: string) => void;
  json: boolean;
  capture: CaptureResult;
  preflight?: PrivateRegressionPreflight;
}>): void {
  const { write, json, capture, preflight } = options;
  const output = {
    status: preflight?.status ?? capture.status,
    capture_status: capture.status,
    case_id: capture.case.case_id,
    case_path: capture.case_path,
    identity_hashes: {
      prompt: capture.case.task.prompt_sha,
      prompt_artifact: capture.case.evidence.prompt.sha256,
      metadata: capture.case.evidence.metadata.sha256,
      summary: capture.case.evidence.summary.sha256,
      trajectory: capture.case.evidence.trajectory.sha256,
    },
    concerns: preflight?.concerns ?? capture.case.concerns,
    existing: capture.existing,
    preflight_status: preflight?.status ?? null,
  };
  if (json) {
    writeJson(write, output);
    return;
  }
  write(redactText(`CAPTURED case=${capture.case.case_id} path=${capture.case_path}\n`));
  if (preflight) write(formatPreflight(preflight));
}

export function writePreflight(options: Readonly<{
  write: (chunk: string) => void;
  json: boolean;
  result: PrivateRegressionPreflight;
}>): void {
  const { write, json, result } = options;
  const output = {
    status: result.status,
    case_id: result.case_id,
    concerns: result.concerns,
    actual_exit: result.actual_exit,
    source_main_unchanged: result.source_main_unchanged,
    artifact_hashes_match: result.artifact_hashes_match,
    temporary_worktree: result.temporary_worktree,
    errors: result.errors,
  };
  if (json) writeJson(write, output);
  else write(formatPreflight(result));
}

export function writeCompare(options: Readonly<{
  write: (chunk: string) => void;
  json: boolean;
  result: PrivateRegressionCompare;
}>): void {
  const { write, json, result } = options;
  const output = {
    status: result.status,
    case_id: result.case_id,
    before: result.before,
    candidate: result.candidate,
    concerns: result.concerns,
    source_main_unchanged: result.source_main_unchanged,
    artifact_hashes_match: result.artifact_hashes_match,
    temporary_worktree: result.temporary_worktree,
    errors: result.errors,
  };
  if (json) writeJson(write, output);
  else write(formatCompare(result));
}

export function writeFailure(options: Readonly<{
  write: (chunk: string) => void;
  json: boolean;
  status: "INVALID_CASE" | "INFRA_ERROR";
  error: unknown;
}>): void {
  const { write, json, status, error } = options;
  const message = redactText(error instanceof Error ? error.message : String(error));
  if (json) writeJson(write, { status, error: message });
  else write(`${status}: ${message}\n`);
}

function formatPreflight(result: PrivateRegressionPreflight): string {
  const lines = [
    `${result.status} case=${result.case_id} exit=${String(result.actual_exit)}`,
    `source_main_unchanged=${result.source_main_unchanged} artifact_hashes_match=${result.artifact_hashes_match}`,
    "warning: verifier runs in a git worktree, not an OS sandbox",
    ...result.concerns.map((concern) => `concern: ${concern}`),
    ...result.errors.map((error) => `error: ${error}`),
  ];
  return redactText(`${lines.join("\n")}\n`);
}

function formatCompare(result: PrivateRegressionCompare): string {
  const lines = [
    `${result.status} case=${result.case_id}`,
    `before kind=${result.before.kind} exit=${String(result.before.actual_exit)} root=${result.before.root}`,
    `candidate exit=${String(result.candidate.actual_exit)} root=${result.candidate.root}`,
    `source_main_unchanged=${result.source_main_unchanged} artifact_hashes_match=${result.artifact_hashes_match}`,
    "warning: verifier runs without OS-level isolation; FIXED does not authorize merge",
    ...result.concerns.map((concern) => `concern: ${concern}`),
    ...result.errors.map((error) => `error: ${error}`),
  ];
  return redactText(`${lines.join("\n")}\n`);
}

function writeJson(write: (chunk: string) => void, value: unknown): void {
  write(`${JSON.stringify(OUTPUT_REDACTOR.redact(value))}\n`);
}

function redactText(value: string): string {
  const redacted = OUTPUT_REDACTOR.redact(value);
  return typeof redacted === "string" ? redacted : "redacted output";
}
