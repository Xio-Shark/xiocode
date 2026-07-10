import { createHash } from "node:crypto";

import type {
  EvidenceReference,
  PrivateRegressionCase,
  PrivateRegressionPreflight,
  PromptEvidenceReference,
  RunProvenance,
} from "./types.ts";

const SHA256 = /^[a-f0-9]{64}$/;

export function decodeRunProvenance(value: unknown): RunProvenance {
  const root = objectValue(value, "run provenance");
  schema(root, "xio-run-provenance.v1");
  return {
    schema_version: "xio-run-provenance.v1",
    workspace_root: requiredString(root, "workspace_root"),
    main_root: requiredString(root, "main_root"),
    base_commit: requiredString(root, "base_commit"),
    branch: nullableString(root, "branch"),
    dirty: requiredBoolean(root, "dirty"),
    dirty_summary_sha: requiredHash(root, "dirty_summary_sha"),
    xiocode_revision: nullableString(root, "xiocode_revision"),
    created_at: requiredString(root, "created_at"),
  };
}

export function decodePrivateRegressionCase(value: unknown): PrivateRegressionCase {
  const root = objectValue(value, "private regression case");
  schema(root, "private-regression-case.v1");
  const source = objectField(root, "source");
  const task = objectField(root, "task");
  const verifier = objectField(root, "verifier");
  const runtime = objectField(root, "runtime");
  const evidence = objectField(root, "evidence");
  const privacy = objectField(root, "privacy");
  const decoded: PrivateRegressionCase = {
    schema_version: "private-regression-case.v1",
    case_id: requiredHash(root, "case_id"),
    created_at: requiredString(root, "created_at"),
    source: decodeSource(source),
    task: decodeTask(task),
    verifier: decodeVerifier(verifier),
    runtime: decodeRuntime(runtime),
    evidence: decodeEvidence(evidence),
    privacy: decodePrivacy(privacy),
    concerns: stringArray(root.concerns, "concerns"),
  };
  return decoded;
}

export function decodePrivateRegressionPreflight(value: unknown): PrivateRegressionPreflight {
  const root = objectValue(value, "private regression preflight");
  schema(root, "private-regression-preflight.v1");
  const status = root.status;
  if (status !== "BASE_RED" && status !== "INVALID_CASE" && status !== "INFRA_ERROR") {
    throw new Error("invalid preflight status");
  }
  if (root.host_isolation !== "unsupported") {
    throw new Error("invalid host_isolation");
  }
  return {
    schema_version: "private-regression-preflight.v1",
    case_id: requiredHash(root, "case_id"),
    status,
    actual_exit: nullableInteger(root, "actual_exit"),
    duration_ms: nonNegativeInteger(root, "duration_ms"),
    source_main_unchanged: requiredBoolean(root, "source_main_unchanged"),
    artifact_hashes_match: requiredBoolean(root, "artifact_hashes_match"),
    temporary_worktree: nullableString(root, "temporary_worktree"),
    host_isolation: "unsupported",
    concerns: stringArray(root.concerns, "concerns"),
    errors: stringArray(root.errors, "errors"),
  };
}

export function decodeRunMetadata(value: unknown): Readonly<{
  run_id: string;
  provider: string | null;
  model: string | null;
}> {
  const root = objectValue(value, "run metadata");
  return {
    run_id: requiredString(root, "run_id"),
    provider: optionalString(root.provider),
    model: optionalString(root.model),
  };
}

export function decodeRunSummary(value: unknown): Readonly<{
  run_id: string;
  status: "success" | "failed";
}> {
  const root = objectValue(value, "run summary");
  const status = root.status;
  if (status !== "success" && status !== "failed") {
    throw new Error("run summary status must be success or failed");
  }
  return { run_id: requiredString(root, "run_id"), status };
}

export function decodeLegacyTrajectoryPrompt(value: unknown): string | null {
  const root = objectValue(value, "trajectory");
  if (!Array.isArray(root.messages)) {
    return null;
  }
  const prompts: string[] = [];
  for (const message of root.messages) {
    const record = objectValue(message, "trajectory message");
    if (record.role === "user" && typeof record.content === "string" && record.content.length > 0) {
      prompts.push(record.content);
    }
  }
  return prompts.length === 1 ? prompts[0]! : null;
}

export function decodePromptArtifact(value: unknown): Readonly<
  | { schema_version: "xio-run-prompt.v1"; prompt_sha: string }
  | { schema_version: "xio-run-prompt.v2"; content: string; prompt_sha: string }
> {
  const root = objectValue(value, "run prompt artifact");
  if (root.schema_version === "xio-run-prompt.v1") {
    return {
      schema_version: "xio-run-prompt.v1",
      prompt_sha: requiredHash(root, "prompt_sha"),
    };
  }
  schema(root, "xio-run-prompt.v2");
  const content = requiredString(root, "content");
  const promptSha = requiredHash(root, "prompt_sha");
  if (createHash("sha256").update(content).digest("hex") !== promptSha) {
    throw new Error("prompt content hash mismatch");
  }
  return { schema_version: "xio-run-prompt.v2", content, prompt_sha: promptSha };
}

function decodeSource(value: Record<string, unknown>): PrivateRegressionCase["source"] {
  const provenance = value.provenance_kind;
  if (provenance !== "recorded" && provenance !== "user_override") {
    throw new Error("invalid source provenance_kind");
  }
  return {
    run_id: requiredString(value, "run_id"),
    repo_root: requiredString(value, "repo_root"),
    base_commit: requiredCommit(value, "base_commit"),
    dirty: requiredBoolean(value, "dirty"),
    dirty_summary_sha: nullableHash(value, "dirty_summary_sha"),
    provenance_kind: provenance,
  };
}

function decodeTask(value: Record<string, unknown>): PrivateRegressionCase["task"] {
  return {
    prompt_sha: requiredHash(value, "prompt_sha"),
    failure_type: requiredString(value, "failure_type"),
    failure_statement: requiredString(value, "failure_statement"),
  };
}

function decodeVerifier(value: Record<string, unknown>): PrivateRegressionCase["verifier"] {
  return {
    command: requiredString(value, "command"),
    expected_exit: integer(value, "expected_exit"),
    timeout_ms: positiveInteger(value, "timeout_ms"),
  };
}

function decodeRuntime(value: Record<string, unknown>): PrivateRegressionCase["runtime"] {
  return {
    provider: nullableString(value, "provider"),
    model: nullableString(value, "model"),
    xiocode_revision: nullableString(value, "xiocode_revision"),
  };
}

function decodeEvidence(value: Record<string, unknown>): PrivateRegressionCase["evidence"] {
  return {
    prompt: decodePromptReference(value.prompt),
    metadata: decodeReference(value.metadata, "metadata"),
    summary: decodeReference(value.summary, "summary"),
    trajectory: decodeReference(value.trajectory, "trajectory"),
  };
}

function decodePromptReference(value: unknown): PromptEvidenceReference {
  const reference = objectValue(value, "prompt evidence");
  const source = reference.source;
  if (source !== "prompt_artifact" && source !== "legacy_trajectory") {
    throw new Error("invalid prompt evidence source");
  }
  return { ...decodeReference(reference, "prompt"), source };
}

function decodeReference(value: unknown, name: string): EvidenceReference {
  const reference = objectValue(value, `${name} evidence`);
  return { ref: requiredString(reference, "ref"), sha256: requiredHash(reference, "sha256") };
}

function decodePrivacy(value: Record<string, unknown>): PrivateRegressionCase["privacy"] {
  if (value.classification !== "local_private" || value.redaction_status !== "clean") {
    throw new Error("invalid privacy contract");
  }
  return { classification: "local_private", redaction_status: "clean" };
}

function schema(value: Record<string, unknown>, expected: string): void {
  if (value.schema_version !== expected) {
    throw new Error(`unsupported schema: ${String(value.schema_version)}`);
  }
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function objectField(value: Record<string, unknown>, name: string): Record<string, unknown> {
  return objectValue(value[name], name);
}

function requiredString(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return field;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value !== "unknown" ? value : null;
}

function nullableString(value: Record<string, unknown>, name: string): string | null {
  const field = value[name];
  if (field === null) return null;
  return requiredString(value, name);
}

function requiredBoolean(value: Record<string, unknown>, name: string): boolean {
  if (typeof value[name] !== "boolean") throw new Error(`${name} must be boolean`);
  return value[name];
}

function integer(value: Record<string, unknown>, name: string): number {
  if (!Number.isInteger(value[name])) throw new Error(`${name} must be an integer`);
  return Number(value[name]);
}

function nullableInteger(value: Record<string, unknown>, name: string): number | null {
  return value[name] === null ? null : integer(value, name);
}

function positiveInteger(value: Record<string, unknown>, name: string): number {
  const field = integer(value, name);
  if (field <= 0) throw new Error(`${name} must be positive`);
  return field;
}

function nonNegativeInteger(value: Record<string, unknown>, name: string): number {
  const field = integer(value, name);
  if (field < 0) throw new Error(`${name} must be non-negative`);
  return field;
}

function requiredHash(value: Record<string, unknown>, name: string): string {
  const field = requiredString(value, name);
  if (!SHA256.test(field)) throw new Error(`${name} must be a SHA-256`);
  return field;
}

function requiredCommit(value: Record<string, unknown>, name: string): string {
  const field = requiredString(value, name);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(field)) {
    throw new Error(`${name} must be a full git object ID`);
  }
  return field;
}

function nullableHash(value: Record<string, unknown>, name: string): string | null {
  return value[name] === null ? null : requiredHash(value, name);
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be a string array`);
  }
  return value;
}
