import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyOracle, materializeFixture } from "./fixture-materializer.ts";
import { gradeWorkspace } from "./grader.ts";
import { runRuntimeInvariants } from "./invariant-preflight.ts";

import type { LoadedSuite } from "./suite-loader.ts";

export type PreflightResult = Readonly<{
  ok: boolean;
  checks: readonly string[];
  errors: readonly string[];
}>;

export async function runPreflight(trustedRoot: string, suite: LoadedSuite): Promise<PreflightResult> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "xio-eval-preflight-"));
  const checks: string[] = [];
  const errors: string[] = [];
  try {
    for (const fixture of suite.fixtures) {
      await validateFixture(trustedRoot, parent, fixture, checks, errors);
    }
    await validateTamperResistance(trustedRoot, parent, suite, checks, errors);
    await validateRuntimeInvariants(parent, suite, checks, errors);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
  return { ok: errors.length === 0, checks, errors };
}

async function validateRuntimeInvariants(
  parent: string,
  suite: LoadedSuite,
  checks: string[],
  errors: string[],
): Promise<void> {
  const fixture = suite.fixtures.find((candidate) => candidate.visibility === "holdout");
  if (!fixture) {
    errors.push("runtime invariant checks require a holdout fixture");
    return;
  }
  const root = await materializeFixture(fixture, parent);
  try {
    checks.push(...await runRuntimeInvariants({
      fixtureRoot: root,
      worktreeRoot: path.join(parent, "invariant-worktrees"),
    }));
  } catch (error) {
    errors.push(`runtime invariant failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function validateFixture(
  trustedRoot: string,
  parent: string,
  fixture: LoadedSuite["fixtures"][number],
  checks: string[],
  errors: string[],
): Promise<void> {
  const root = await materializeFixture(fixture, parent);
  const materialized = await collectPublicFiles(root);
  const expected = Object.keys(fixture.public_files).sort();
  if (materialized.join("\n") !== expected.join("\n")) {
    errors.push(`${fixture.id}: public materialization exposed unexpected files`);
    return;
  }
  const base = await gradeWorkspace({ trustedRoot, workspace: root, fixture });
  if (base.status !== "graded" || base.task_resolved) {
    errors.push(`${fixture.id}: base must be graded red (${base.error ?? base.details.join(", ")})`);
    return;
  }
  await applyOracle(root, fixture);
  const oracle = await gradeWorkspace({ trustedRoot, workspace: root, fixture });
  if (oracle.status !== "graded" || !oracle.task_resolved) {
    errors.push(`${fixture.id}: oracle must be green (${oracle.error ?? oracle.details.join(", ")})`);
    return;
  }
  if (base.duration_ms >= 5_000 || oracle.duration_ms >= 5_000) {
    errors.push(`${fixture.id}: grader exceeded 5 seconds`);
    return;
  }
  checks.push(`${fixture.id}: public-only, base red, oracle green`);
}

async function validateTamperResistance(
  trustedRoot: string,
  parent: string,
  suite: LoadedSuite,
  checks: string[],
  errors: string[],
): Promise<void> {
  const fixture = suite.fixtures.find((candidate) => candidate.visibility === "holdout");
  if (!fixture) {
    errors.push("tamper check requires a holdout fixture");
    return;
  }
  const root = await materializeFixture(fixture, parent);
  await writeFile(
    path.join(root, "package.json"),
    '{"name":"tampered","type":"module","scripts":{"check":"exit 0"}}\n',
    "utf8",
  );
  const result = await gradeWorkspace({ trustedRoot, workspace: root, fixture });
  if (result.task_resolved || result.forbidden_files_unchanged) {
    errors.push("candidate package script tamper changed trusted outcome");
    return;
  }
  checks.push("candidate package script cannot manufacture trusted green");
}

async function collectPublicFiles(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (relative.length === 0 && entry.name === ".git") {
      continue;
    }
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectPublicFiles(root, child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files.sort();
}
