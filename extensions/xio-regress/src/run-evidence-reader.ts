import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { SecretRedactor } from "../../xio-evolve/src/secret-redactor.ts";
import {
  decodeLegacyTrajectoryPrompt,
  decodePromptArtifact,
  decodeRunMetadata,
  decodeRunProvenance,
  decodeRunSummary,
} from "./decoder.ts";

import type {
  PrivateRegressionCase,
  PromptEvidenceReference,
  RunEvidence,
} from "./types.ts";

const RUN_ID = /^[A-Za-z0-9._-]+$/;
const PROMPT_REDACTOR = new SecretRedactor();

export async function readRunEvidence(runRoot: string, runId: string): Promise<RunEvidence> {
  const root = runDirectory(runRoot, runId);
  const paths = {
    metadata: path.join(root, "metadata.json"),
    summary: path.join(root, "summary.json"),
    trajectory: path.join(root, "trajectory.json"),
    provenance: path.join(root, "provenance.json"),
    prompt: path.join(root, "prompt.json"),
  };
  const [metadataRaw, summaryRaw, trajectoryRaw] = await Promise.all([
    readRequired(paths.metadata),
    readRequired(paths.summary),
    readRequired(paths.trajectory),
  ]);
  const metadata = decodeRunMetadata(parseJson(metadataRaw, "metadata.json"));
  const summary = decodeRunSummary(parseJson(summaryRaw, "summary.json"));
  if (metadata.run_id !== runId || summary.run_id !== runId) {
    throw new Error("run artifact identity mismatch");
  }
  const trajectory = parseJson(trajectoryRaw, "trajectory.json");
  const prompt = await readPromptSource(paths.prompt, paths.trajectory, trajectoryRaw, trajectory);
  const provenance = await readOptional(paths.provenance);
  return {
    metadata,
    summary,
    prompt_sha: prompt.prompt_sha,
    prompt_source: prompt.reference.source,
    provenance: provenance === null ? null : decodeRunProvenance(parseJson(provenance, "provenance.json")),
    references: {
      prompt: prompt.reference,
      metadata: { ref: paths.metadata, sha256: sha256(metadataRaw) },
      summary: { ref: paths.summary, sha256: sha256(summaryRaw) },
      trajectory: { ref: paths.trajectory, sha256: sha256(trajectoryRaw) },
    },
  };
}

export async function evidenceHashesMatch(regression: PrivateRegressionCase): Promise<boolean> {
  const entries = Object.values(regression.evidence);
  try {
    const contents = await Promise.all(entries.map((entry) => readFile(entry.ref)));
    return entries.every((entry, index) => sha256(contents[index]!) === entry.sha256);
  } catch {
    return false;
  }
}

export async function readReplayPrompt(regression: PrivateRegressionCase): Promise<string> {
  const reference = regression.evidence.prompt;
  const raw = await readRequired(reference.ref);
  if (sha256(raw) !== reference.sha256) {
    throw new Error("prompt artifact hash mismatch");
  }
  const content = reference.source === "prompt_artifact"
    ? promptFromArtifact(parseJson(raw, "prompt.json"))
    : promptFromLegacyTrajectory(parseJson(raw, "trajectory.json"));
  if (sha256Text(content) !== regression.task.prompt_sha) {
    throw new Error("replay prompt hash mismatch");
  }
  return content;
}

async function readPromptSource(
  promptPath: string,
  trajectoryPath: string,
  trajectoryRaw: Buffer,
  trajectory: unknown,
): Promise<Readonly<{ prompt_sha: string; reference: PromptEvidenceReference }>> {
  const promptRaw = await readOptional(promptPath);
  if (promptRaw !== null) {
    const artifact = decodePromptArtifact(parseJson(promptRaw, "prompt.json"));
    if (artifact.schema_version === "xio-run-prompt.v2") {
      const content = assertRedacted(artifact.content);
      return {
        prompt_sha: sha256Text(content),
        reference: { source: "prompt_artifact", ref: promptPath, sha256: sha256(promptRaw) },
      };
    }
    const legacy = promptFromLegacyTrajectory(trajectory);
    const replaySha = sha256Text(legacy);
    const rawPrompt = decodeLegacyTrajectoryPrompt(trajectory)!;
    if (artifact.prompt_sha !== replaySha && artifact.prompt_sha !== sha256Text(rawPrompt)) {
      throw new Error("legacy prompt hash does not match trajectory");
    }
    return legacyPromptSource(trajectoryPath, trajectoryRaw, replaySha);
  }
  const legacy = promptFromLegacyTrajectory(trajectory);
  return legacyPromptSource(trajectoryPath, trajectoryRaw, sha256Text(legacy));
}

function legacyPromptSource(
  trajectoryPath: string,
  trajectoryRaw: Buffer,
  promptSha: string,
): Readonly<{ prompt_sha: string; reference: PromptEvidenceReference }> {
  return {
    prompt_sha: promptSha,
    reference: { source: "legacy_trajectory", ref: trajectoryPath, sha256: sha256(trajectoryRaw) },
  };
}

function promptFromArtifact(value: unknown): string {
  const artifact = decodePromptArtifact(value);
  if (artifact.schema_version !== "xio-run-prompt.v2") {
    throw new Error("legacy prompt artifact has no replayable content");
  }
  return assertRedacted(artifact.content);
}

function promptFromLegacyTrajectory(value: unknown): string {
  const prompt = decodeLegacyTrajectoryPrompt(value);
  if (prompt === null) {
    throw new Error("legacy trajectory must contain exactly one replayable user prompt");
  }
  return redactPrompt(prompt);
}

function assertRedacted(content: string): string {
  if (redactPrompt(content) !== content) {
    throw new Error("prompt artifact content is not redacted");
  }
  return content;
}

function redactPrompt(content: string): string {
  const redacted = PROMPT_REDACTOR.redact(content);
  if (typeof redacted !== "string") {
    throw new Error("redacted prompt must remain a string");
  }
  return redacted;
}

function runDirectory(runRoot: string, runId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new Error("invalid run id");
  }
  const root = path.resolve(runRoot);
  const resolved = path.resolve(root, runId);
  if (path.dirname(resolved) !== root) {
    throw new Error("run id escapes run root");
  }
  return resolved;
}

async function readRequired(filePath: string): Promise<Buffer> {
  try {
    return await readFile(filePath);
  } catch (error) {
    throw new Error(`missing run artifact: ${path.basename(filePath)}`, { cause: error });
  }
}

async function readOptional(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return null;
    throw error;
  }
}

function parseJson(value: Buffer, name: string): unknown {
  try {
    return JSON.parse(value.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON in ${name}`, { cause: error });
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
