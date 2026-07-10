import { writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SecretRedactor } from "../../extensions/xio-evolve/src/secret-redactor.ts";
import {
  InvalidRegressionCaseError,
  RegressionCapture,
  RegressionCaseStore,
  RegressionPreflight,
} from "../../extensions/xio-regress/src/index.ts";
import { expandHome, parseXioConfig } from "./config-parser.ts";

import type { CaptureInput, CaptureResult, PrivateRegressionPreflight } from "../../extensions/xio-regress/src/types.ts";

type RegressCommand = "create" | "preflight" | "help";
const OUTPUT_REDACTOR = new SecretRedactor();

export type RegressCliArgs = Readonly<{
  command: RegressCommand;
  json: boolean;
  noPreflight: boolean;
  caseId?: string;
  capture?: CaptureInput;
}>;

export type RegressCliOptions = Readonly<{
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  write?: (chunk: string) => void;
  runRoot?: string;
  store?: RegressionCaseStore;
  now?: () => Date;
}>;

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
    const runRoot = options.runRoot ?? await resolveRunRoot(options.cwd ?? process.cwd(), env);
    const capture = await new RegressionCapture({ run_root: runRoot, store, now: options.now }).capture(args.capture!);
    const preflight = args.noPreflight ? undefined : await new RegressionPreflight({ store, env }).run(capture.case.case_id);
    writeCapture({ write, json: args.json, capture, preflight });
    return preflight ? preflightExit(preflight.status) : 0;
  } catch (error) {
    const invalid = error instanceof InvalidRegressionCaseError;
    writeFailure({ write, json: args.json, status: invalid ? "INVALID_CASE" : "INFRA_ERROR", error });
    return invalid ? 2 : 3;
  }
}

export function parseRegressArgs(argv: readonly string[]): RegressCliArgs {
  const command = parseCommand(argv[0]);
  if (command === "help") return { command, json: false, noPreflight: false };
  const values = parseFlags(argv.slice(1));
  const json = values.has("--json");
  const noPreflight = values.has("--no-preflight");
  if (command === "preflight") {
    assertOnly(values, new Set(["--case", "--json"]));
    return { command, json, noPreflight: false, caseId: required(values, "--case") };
  }
  if (values.has("--case")) throw new Error("--case is only valid for preflight");
  return {
    command,
    json,
    noPreflight,
    capture: {
      run_id: required(values, "--run"),
      repo_root: optional(values, "--repo"),
      base_commit: optional(values, "--base"),
      failure_type: required(values, "--failure-type"),
      failure_statement: required(values, "--failure"),
      verifier_command: required(values, "--verify"),
      expected_exit: optionalInteger(values, "--expect-exit"),
      timeout_ms: optionalInteger(values, "--timeout-ms"),
    },
  };
}

function parseFlags(argv: readonly string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  const booleans = new Set(["--json", "--no-preflight"]);
  const allowed = new Set([
    ...booleans,
    "--run", "--repo", "--base", "--failure-type", "--failure",
    "--verify", "--expect-exit", "--timeout-ms", "--case",
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

function writeCapture(options: Readonly<{
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

function writePreflight(options: Readonly<{
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
  if (json) {
    writeJson(write, output);
  } else {
    write(formatPreflight(result));
  }
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

function writeFailure(options: Readonly<{
  write: (chunk: string) => void;
  json: boolean;
  status: "INVALID_CASE" | "INFRA_ERROR";
  error: unknown;
}>): void {
  const { write, json, status, error } = options;
  const message = redactText(error instanceof Error ? error.message : String(error));
  if (json) {
    writeJson(write, { status, error: message });
  } else {
    write(`${status}: ${message}\n`);
  }
}

function writeJson(write: (chunk: string) => void, value: unknown): void {
  write(`${JSON.stringify(OUTPUT_REDACTOR.redact(value))}\n`);
}

function redactText(value: string): string {
  const redacted = OUTPUT_REDACTOR.redact(value);
  return typeof redacted === "string" ? redacted : "redacted output";
}

function parseCommand(value: string | undefined): RegressCommand {
  if (value === "create" || value === "preflight") return value;
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

function assertOnly(values: Map<string, string | true>, allowed: ReadonlySet<string>): void {
  const invalid = [...values.keys()].find((flag) => !allowed.has(flag));
  if (invalid) throw new Error(`unknown argument for preflight: ${invalid}`);
}

function preflightExit(status: PrivateRegressionPreflight["status"]): number {
  if (status === "INVALID_CASE") return 2;
  if (status === "INFRA_ERROR") return 3;
  return 0;
}

function regressHelp(): string {
  return [
    "xio regress — capture a user-confirmed private regression",
    "",
    "Usage:",
    "  xio regress create --run ID --failure-type TYPE --failure TEXT --verify CMD [--repo PATH --base SHA] [--json]",
    "  xio regress preflight --case ID [--json]",
    "",
    "Capture is local-only. Preflight proves base-red; it does not prove a fix or authorize merge.",
    "Verifier commands run in temporary git worktrees without OS-level isolation.",
    "",
  ].join("\n");
}

function writeStdout(chunk: string): void {
  writeSync(process.stdout.fd, chunk);
}
