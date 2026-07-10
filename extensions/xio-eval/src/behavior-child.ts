import path from "node:path";
import { pathToFileURL } from "node:url";

import { fixtureById } from "./fixtures.ts";
import { spawnCommand } from "./process.ts";
import { loadFixture } from "./suite-loader.ts";

import type { FixtureGraderConfig } from "./types.ts";

const RESULT_MARKER = "XIO_EVAL_BEHAVIOR=";

type BehaviorResult = Readonly<{
  status: "graded" | "infra_error";
  f2p: boolean;
  p2p: boolean;
  details: readonly string[];
  error?: string;
}>;

await main();

async function main(): Promise<void> {
  const [caseId, workspace] = process.argv.slice(2);
  if (!caseId || !workspace) {
    writeResult(infraResult("behavior child requires case id and workspace"));
    return;
  }
  try {
    const fixture = loadFixture(fixtureById(caseId));
    writeResult({ status: "graded", ...await gradeBehavior(workspace, fixture.grader) });
  } catch (error) {
    writeResult(infraResult(error instanceof Error ? error.message : String(error)));
  }
}

async function gradeBehavior(
  workspace: string,
  config: FixtureGraderConfig,
): Promise<{ f2p: boolean; p2p: boolean; details: readonly string[] }> {
  switch (config.kind) {
    case "clamp":
      return gradeClamp(workspace, config);
    case "contract":
      return gradeContract(workspace, config);
    case "cli":
      return gradeCli(workspace, config);
    case "parser":
      return gradeParser(workspace, config);
    case "scope":
      return gradeScope(workspace, config);
  }
}

async function gradeClamp(workspace: string, config: Extract<FixtureGraderConfig, { kind: "clamp" }>) {
  const fn = await exportedFunction(workspace, config.module, config.exportName);
  const f2p = fn(...config.edge) === config.edge[3];
  const p2p = fn(...config.stable) === config.stable[3];
  return resultPair(f2p, p2p, "clamp edge", "clamp stable");
}

async function gradeContract(workspace: string, config: Extract<FixtureGraderConfig, { kind: "contract" }>) {
  const producer = await exportedFunction(workspace, config.producerModule, config.producerExport);
  const consumer = await exportedFunction(workspace, config.consumerModule, config.consumerExport);
  const produced = producer("sample") as Record<string, unknown>;
  const field = config.enabledText.slice(config.enabledText.lastIndexOf(":") + 1);
  const f2p = consumer(produced) === config.enabledText;
  const p2p = consumer({ ...produced, [field]: false }) === config.disabledText;
  return resultPair(f2p, p2p, "contract enabled", "contract disabled");
}

async function gradeCli(workspace: string, config: Extract<FixtureGraderConfig, { kind: "cli" }>) {
  const valid = await runFixtureCli(workspace, config.entry, config.validArgs);
  const invalid = await runFixtureCli(workspace, config.entry, config.invalidArgs);
  const f2p = invalid.code === config.invalidExitCode && invalid.stderr.trim() === config.invalidStderr;
  const p2p = valid.code === 0 && valid.stdout.trim() === config.validStdout;
  return resultPair(f2p, p2p, "invalid CLI contract", "valid CLI regression");
}

async function gradeParser(workspace: string, config: Extract<FixtureGraderConfig, { kind: "parser" }>) {
  const fn = await exportedFunction(workspace, config.module, config.exportName);
  const visible = fn(config.visibleInput) === config.visibleValue;
  const invalidRejected = throws(() => fn("not-a-number")) && throws(() => fn(" "));
  const p2p = fn(config.stableInput) === config.stableValue;
  return resultPair(visible && invalidRejected, p2p, "parser invalid input", "parser stable input");
}

async function gradeScope(workspace: string, config: Extract<FixtureGraderConfig, { kind: "scope" }>) {
  const fn = await exportedFunction(workspace, config.module, config.exportName);
  return resultPair(fn(config.input) === config.expected, fn("") === "", "format behavior", "empty input");
}

async function runFixtureCli(workspace: string, entry: string, args: readonly string[]) {
  const result = await spawnCommand({
    command: process.execPath,
    args: ["--experimental-strip-types", path.join(workspace, entry), ...args],
    cwd: workspace,
    timeoutMs: 2_000,
    detached: false,
  });
  if (result.cleanupError) {
    throw new Error(result.cleanupError);
  }
  return result;
}

async function exportedFunction(
  workspace: string,
  modulePath: string,
  exportName: string,
): Promise<(...args: unknown[]) => unknown> {
  const url = `${pathToFileURL(path.join(workspace, modulePath)).href}?eval=${Date.now()}`;
  const module = await import(url) as Record<string, unknown>;
  const value = module[exportName];
  if (typeof value !== "function") {
    throw new Error(`missing function export ${exportName} in ${modulePath}`);
  }
  return value as (...args: unknown[]) => unknown;
}

function resultPair(f2p: boolean, p2p: boolean, f2pLabel: string, p2pLabel: string) {
  return {
    f2p,
    p2p,
    details: [...(f2p ? [] : [`failed: ${f2pLabel}`]), ...(p2p ? [] : [`failed: ${p2pLabel}`])],
  };
}

function throws(action: () => unknown): boolean {
  try {
    action();
    return false;
  } catch {
    return true;
  }
}

function infraResult(error: string): BehaviorResult {
  return { status: "infra_error", f2p: false, p2p: false, details: [], error };
}

function writeResult(result: BehaviorResult): void {
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`);
}
