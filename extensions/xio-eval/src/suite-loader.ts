import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { TRUSTED_FIXTURES } from "./fixtures.ts";

import type { LoadedFixture, SuiteIdentity, TrustedFixture } from "./types.ts";

const SUITE_ID = "xiocode-capability";
const SUITE_VERSION = "1.0.0";

export type LoadedSuite = Readonly<{
  identity: SuiteIdentity;
  fixtures: readonly LoadedFixture[];
}>;

export async function loadTrustedSuite(trustedRoot: string): Promise<LoadedSuite> {
  const fixtures = TRUSTED_FIXTURES.map((value) => loadFixture(value));
  assertSuiteShape(fixtures);
  const evaluatorRoot = path.join(trustedRoot, "extensions", "xio-eval", "src");
  const evaluatorSha = await hashDirectory(evaluatorRoot);
  const suiteSha = hashValue({
    id: SUITE_ID,
    version: SUITE_VERSION,
    fixtures: fixtures.map(({ public_files, oracle_files, grader, prompt, ...identity }) => identity),
  });
  return {
    identity: {
      suite_id: SUITE_ID,
      suite_version: SUITE_VERSION,
      suite_sha: suiteSha,
      evaluator_sha: evaluatorSha,
    },
    fixtures,
  };
}

export function loadFixture(value: unknown): LoadedFixture {
  const fixture = decodeFixture(value);
  return {
    ...fixture,
    fixture_sha: hashValue(fixture.public_files),
    prompt_sha: hashValue(fixture.prompt),
    grader_sha: hashValue(fixture.grader),
    oracle_sha: hashValue(fixture.oracle_files),
  };
}

export function hashValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function decodeFixture(value: unknown): TrustedFixture {
  const fixture = asRecord(value, "fixture");
  if (fixture.schema_version !== "xio-eval-fixture.v1") {
    throw new Error(`unsupported fixture schema: ${String(fixture.schema_version)}`);
  }
  if (typeof fixture.id !== "string" || typeof fixture.prompt !== "string") {
    throw new Error("fixture id and prompt are required");
  }
  if (!isFamily(fixture.family) || !isVisibility(fixture.visibility)) {
    throw new Error(`invalid fixture family or visibility: ${fixture.id}`);
  }
  if (!isStringRecord(fixture.public_files) || !isStringRecord(fixture.oracle_files)) {
    throw new Error(`fixture files must be string records: ${fixture.id}`);
  }
  if (!Array.isArray(fixture.forbidden_paths) || !fixture.forbidden_paths.every((item) => typeof item === "string")) {
    throw new Error(`fixture forbidden_paths must be strings: ${fixture.id}`);
  }
  if (!isGraderConfig(fixture.grader)) {
    throw new Error(`invalid fixture grader: ${fixture.id}`);
  }
  for (const field of ["max_turns", "wall_timeout_ms", "grader_timeout_ms"]) {
    if (!Number.isInteger(fixture[field]) || Number(fixture[field]) <= 0) {
      throw new Error(`fixture ${field} must be a positive integer: ${fixture.id}`);
    }
  }
  return value as TrustedFixture;
}

function assertSuiteShape(fixtures: readonly LoadedFixture[]): void {
  const ids = new Set<string>();
  for (const fixture of fixtures) {
    if (ids.has(fixture.id)) {
      throw new Error(`duplicate fixture id: ${fixture.id}`);
    }
    ids.add(fixture.id);
  }
  for (const family of ["local-bug", "cross-file-contract", "cli-behavior", "test-and-repair", "scope-safety"]) {
    const variants = fixtures.filter((fixture) => fixture.family === family).map((fixture) => fixture.visibility);
    if (!variants.includes("dev") || !variants.includes("holdout")) {
      throw new Error(`fixture family ${family} requires dev and holdout variants`);
    }
  }
}

async function hashDirectory(root: string): Promise<string> {
  const entries = await collectFiles(root);
  const hash = createHash("sha256");
  for (const file of entries) {
    hash.update(path.relative(root, file));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(target));
    } else if (entry.isFile()) {
      files.push(target);
    }
  }
  return files;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string"));
}

function isVisibility(value: unknown): value is TrustedFixture["visibility"] {
  return value === "dev" || value === "holdout";
}

function isFamily(value: unknown): value is TrustedFixture["family"] {
  return value === "local-bug" || value === "cross-file-contract" || value === "cli-behavior"
    || value === "test-and-repair" || value === "scope-safety";
}

function isGraderConfig(value: unknown): boolean {
  const grader = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (!grader || typeof grader.kind !== "string") {
    return false;
  }
  switch (grader.kind) {
    case "clamp":
      return strings(grader, ["module", "exportName"]) && tuple4(grader.edge) && tuple4(grader.stable);
    case "contract":
      return strings(grader, [
        "producerModule", "producerExport", "consumerModule", "consumerExport", "enabledText", "disabledText",
      ]);
    case "cli":
      return strings(grader, ["entry", "validStdout", "invalidStderr"])
        && stringArray(grader.validArgs) && stringArray(grader.invalidArgs)
        && nonNegativeInteger(grader.invalidExitCode);
    case "parser":
      return strings(grader, ["module", "exportName", "visibleInput", "stableInput"])
        && finiteNumber(grader.visibleValue) && finiteNumber(grader.stableValue);
    case "scope":
      return strings(grader, ["module", "exportName", "input", "expected"]);
    default:
      return false;
  }
}

function strings(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === "string");
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function tuple4(value: unknown): boolean {
  return Array.isArray(value) && value.length === 4 && value.every(finiteNumber);
}

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}
