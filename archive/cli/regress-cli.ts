import { writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  InvalidRegressionCaseError,
  RegressionCapture,
  RegressionCaseStore,
  RegressionCompare,
  RegressionPreflight,
} from "../../extensions/xio-regress/src/index.ts";
import { RunStore } from "../../extensions/xio-evolve/src/run-store.ts";
import { expandHome, parseXioConfig } from "./config-parser.ts";
import {
  writeCapture,
  writeCompare,
  writeFailure,
  writePreflight,
} from "./regress-cli-output.ts";

import type { CaptureInput } from "../../extensions/xio-regress/src/types.ts";
import type { PrivateRegressionCompare, PrivateRegressionPreflight } from "../../extensions/xio-regress/src/types.ts";

type RegressCommand = "create" | "capture" | "preflight" | "compare" | "help";

export type RegressCliArgs = Readonly<{
  command: RegressCommand;
  json: boolean;
  noPreflight: boolean;
  useLastRun: boolean;
  caseId?: string;
  candidate?: string;
  before?: string;
  capture?: Omit<CaptureInput, "run_id"> & Readonly<{ run_id?: string }>;
}>;

export type RegressCliOptions = Readonly<{
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  write?: (chunk: string) => void;
  runRoot?: string;
  store?: RegressionCaseStore;
  now?: () => Date;
}>;

export const DEFAULT_FAILURE_TYPE = "user_task_failure";

export const VERIFIER_TEMPLATE_COMMANDS = [
  "./test.sh",
  "npm run check",
  "npm test",
] as const;

export async function runRegressCli(
  argv: readonly string[],
  options: RegressCliOptions = {},
): Promise<number> {
  const write = options.write ?? writeStdout;
  let args: RegressCliArgs;
  try {
    args = parseRegressArgs(argv);
  } catch (error) {
    writeFailure({ write, json: argv.includes("--json"), status: "INVALID_CASE", error });
    return 2;
  }
  if (args.command === "help") {
    write(regressHelp());
    return 0;
  }
  const env = options.env ?? process.env;
  const store = options.store ?? new RegressionCaseStore(env.XIO_REGRESSION_ROOT);
  try {
    if (args.command === "preflight") {
      const result = await new RegressionPreflight({ store, env }).run(args.caseId!);
      writePreflight({ write, json: args.json, result });
      return preflightExit(result.status);
    }
    if (args.command === "compare") {
      const result = await new RegressionCompare({ store, env }).evaluate({
        caseId: args.caseId!,
        candidateRoot: args.candidate!,
        beforeRoot: args.before,
      });
      writeCompare({ write, json: args.json, result });
      return compareExit(result.status);
    }
    const runRoot = options.runRoot ?? await resolveRunRoot(options.cwd ?? process.cwd(), env);
    const runId = await resolveCaptureRunId(args, runRoot);
    const capture = await new RegressionCapture({ run_root: runRoot, store, now: options.now }).capture({
      ...args.capture!,
      run_id: runId,
    });
    const preflight = args.noPreflight
      ? undefined
      : await new RegressionPreflight({ store, env }).run(capture.case.case_id);
    writeCapture({ write, json: args.json, capture, preflight });
    return preflight ? preflightExit(preflight.status) : 0;
  } catch (error) {
    const invalid = error instanceof InvalidRegressionCaseError;
    writeFailure({ write, json: args.json, status: invalid ? "INVALID_CASE" : "INFRA_ERROR", error });
    return invalid ? 2 : 3;
  }
}

export function parseRegressArgs(argv: readonly string[]): RegressCliArgs {
  if (argv.some((arg) => arg === "--help" || arg === "-h")) {
    return { command: "help", json: false, noPreflight: false, useLastRun: false };
  }
  const command = parseCommand(argv[0]);
  if (command === "help") return { command, json: false, noPreflight: false, useLastRun: false };
  const values = parseFlags(argv.slice(1));
  const json = values.has("--json");
  const noPreflight = values.has("--no-preflight");
  const useLastRun = values.has("--last");
  if (command === "preflight") {
    assertOnly(values, new Set(["--case", "--json"]), "preflight");
    return { command, json, noPreflight: false, useLastRun: false, caseId: required(values, "--case") };
  }
  if (command === "compare") {
    assertOnly(values, new Set(["--case", "--candidate", "--before", "--json"]), "compare");
    return {
      command,
      json,
      noPreflight: false,
      useLastRun: false,
      caseId: required(values, "--case"),
      candidate: required(values, "--candidate"),
      before: optional(values, "--before"),
    };
  }
  if (values.has("--case")) throw new Error("--case is only valid for preflight or compare");
  if (values.has("--candidate") || values.has("--before")) {
    throw new Error("--candidate/--before are only valid for compare");
  }
  const failureType = optional(values, "--failure-type") ?? (
    command === "capture" ? DEFAULT_FAILURE_TYPE : undefined
  );
  if (!failureType) throw new Error("--failure-type is required");
  const runId = optional(values, "--run");
  if (!useLastRun && !runId) {
    throw new Error(command === "capture"
      ? "--run or --last is required"
      : "--run is required");
  }
  return {
    command,
    json,
    noPreflight,
    useLastRun,
    capture: {
      run_id: runId,
      repo_root: optional(values, "--repo"),
      base_commit: optional(values, "--base"),
      failure_type: failureType,
      failure_statement: required(values, "--failure"),
      verifier_command: required(values, "--verify"),
      expected_exit: optionalInteger(values, "--expect-exit"),
      timeout_ms: optionalInteger(values, "--timeout-ms"),
    },
  };
}

export async function resolveLastRunId(runRoot: string): Promise<string> {
  const recent = await new RunStore({ root: runRoot }).listRecent(1);
  const runId = recent[0]?.run_id;
  if (!runId) {
    throw new InvalidRegressionCaseError(`no runs found under ${runRoot}`);
  }
  return runId;
}

async function resolveCaptureRunId(args: RegressCliArgs, runRoot: string): Promise<string> {
  if (args.useLastRun) return resolveLastRunId(runRoot);
  const runId = args.capture?.run_id;
  if (!runId) throw new Error("--run is required");
  return runId;
}

function parseFlags(argv: readonly string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  const booleans = new Set(["--json", "--no-preflight", "--last"]);
  const allowed = new Set([
    ...booleans,
    "--run", "--repo", "--base", "--failure-type", "--failure",
    "--verify", "--expect-exit", "--timeout-ms", "--case",
    "--candidate", "--before",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    const [flag, inline] = splitFlag(raw);
    if (!allowed.has(flag)) throw new Error(`unknown argument: ${raw}`);
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    if (booleans.has(flag)) {
      if (inline !== undefined) throw new Error(`${flag} does not accept a value`);
      values.set(flag, true);
      continue;
    }
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }
  return values;
}

async function resolveRunRoot(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (env.XIO_RUN_ROOT) return expandHome(env.XIO_RUN_ROOT);
  const configPath = expandHome(env.XIO_CONFIG ?? path.join(os.homedir(), ".xiocode", "config.toml"));
  let content = "";
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
  return expandHome(parseXioConfig(content, { cwd }).xio.general.runRoot);
}

function parseCommand(value: string | undefined): RegressCommand {
  if (value === "create" || value === "capture" || value === "preflight" || value === "compare") {
    return value;
  }
  if (value === undefined || value === "help" || value === "--help" || value === "-h") return "help";
  throw new Error(`unknown command: ${value}`);
}

function splitFlag(value: string): readonly [string, string | undefined] {
  const index = value.indexOf("=");
  return index < 0 ? [value, undefined] : [value.slice(0, index), value.slice(index + 1)];
}

function required(values: Map<string, string | true>, flag: string): string {
  const value = values.get(flag);
  if (typeof value !== "string" || value.length === 0) throw new Error(`${flag} is required`);
  return value;
}

function optional(values: Map<string, string | true>, flag: string): string | undefined {
  const value = values.get(flag);
  return typeof value === "string" ? value : undefined;
}

function optionalInteger(values: Map<string, string | true>, flag: string): number | undefined {
  const value = values.get(flag);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new Error(`${flag} must be an integer`);
  return Number.parseInt(value, 10);
}

function assertOnly(
  values: Map<string, string | true>,
  allowed: ReadonlySet<string>,
  command: string,
): void {
  const invalid = [...values.keys()].find((flag) => !allowed.has(flag));
  if (invalid) throw new Error(`unknown argument for ${command}: ${invalid}`);
}

function preflightExit(status: PrivateRegressionPreflight["status"]): number {
  if (status === "INVALID_CASE") return 2;
  if (status === "INFRA_ERROR") return 3;
  return 0;
}

function compareExit(status: PrivateRegressionCompare["status"]): number {
  if (status === "FIXED") return 0;
  if (status === "STILL_RED") return 1;
  if (status === "INVALID_CASE") return 2;
  return 3;
}

export function regressHelp(): string {
  return [
    "xio regress — capture and compare private regressions",
    "",
    "Usage:",
    "  xio regress capture --last --failure TEXT --verify CMD [--json]",
    "  xio regress create --run ID --failure-type TYPE --failure TEXT --verify CMD [--repo PATH --base SHA] [--json]",
    "  xio regress preflight --case ID [--json]",
    "  xio regress compare --case ID --candidate PATH [--before PATH] [--json]",
    "",
    "Shortcuts:",
    "  capture defaults --failure-type to user_task_failure",
    "  --last uses the newest run under the run root",
    "  --no-preflight skips auto base-red preflight after create/capture",
    "",
    "Verifier templates (examples):",
    ...VERIFIER_TEMPLATE_COMMANDS.map((cmd) => `  ${cmd}`),
    "",
    "Capture is local-only. Preflight proves base-red.",
    "Compare proves whether a candidate fixes the frozen verifier; FIXED does not authorize merge.",
    "Verifier commands run without OS-level isolation.",
    "In a live session, /regress prompts for failure + verifier from the current run.",
    "",
  ].join("\n");
}

function writeStdout(chunk: string): void {
  writeSync(process.stdout.fd, chunk);
}
