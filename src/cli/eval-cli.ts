import { writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseModelRef } from "../../extensions/xio-eval/src/eval-identity.ts";
import { EvalRunner } from "../../extensions/xio-eval/src/index.ts";

import type { CandidateMode, EvalReport } from "../../extensions/xio-eval/src/types.ts";

const MAX_REPEAT = 10;

export type EvalCliArgs = Readonly<{
  command: "preflight" | "smoke" | "compare" | "help";
  json: boolean;
  candidateMode: CandidateMode;
  model?: string;
  repeat: number;
  beforeRoot?: string;
  candidateRoot?: string;
  caseIds: readonly string[];
  priceTablePath?: string;
  deprecations: readonly string[];
}>;

export async function runEvalCli(
  argv: readonly string[],
  options: Readonly<{
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    write?: (chunk: string) => void;
    writeErr?: (chunk: string) => void;
    trustedRoot?: string;
  }> = {},
): Promise<number> {
  const write = options.write ?? writeStdout;
  const writeErr = options.writeErr ?? writeStderr;
  let args: EvalCliArgs;
  try {
    args = parseEvalArgs(argv);
  } catch (error) {
    write(`xio eval: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  for (const notice of args.deprecations) {
    writeErr(`xio eval: warning: ${notice}\n`);
  }
  if (args.command === "help") {
    write(evalHelp());
    return 0;
  }
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const trustedRoot = options.trustedRoot ?? packageRoot();
  const env = options.env ?? process.env;
  const runner = new EvalRunner({
    trusted_root: trustedRoot,
    before_root: args.beforeRoot ? path.resolve(cwd, args.beforeRoot) : undefined,
    candidate_root: args.candidateRoot ? path.resolve(cwd, args.candidateRoot) : trustedRoot,
    candidate_mode: args.candidateMode,
    model: args.model,
    repeat: args.repeat,
    eval_root: env.XIO_EVAL_ROOT,
    env,
    case_ids: args.caseIds.length > 0 ? args.caseIds : undefined,
    price_table_path: args.priceTablePath
      ? path.resolve(cwd, args.priceTablePath)
      : env.XIO_EVAL_PRICE_TABLE,
  });
  try {
    const report = await runCommand(runner, args.command);
    write(args.json ? `${JSON.stringify(report)}\n` : formatEvalReport(report));
    return exitCode(report.status);
  } catch (error) {
    write(`xio eval: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}

export function parseEvalArgs(argv: readonly string[]): EvalCliArgs {
  const first = argv[0];
  const command = first === "preflight" || first === "smoke" || first === "compare"
    ? first
    : first === undefined || first === "help" || first === "--help" || first === "-h"
    ? "help"
    : invalidCommand(first);
  let json = false;
  let candidateMode: CandidateMode = "real";
  let model: string | undefined;
  let repeat = 1;
  let beforeRoot: string | undefined;
  let candidateRoot: string | undefined;
  let priceTablePath: string | undefined;
  const caseIds: string[] = [];
  const deprecations: string[] = [];
  let modeFlag: "--candidate-mode" | "--provider" | undefined;
  let sawModel = false;
  let sawRepeat = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--candidate-mode") {
      assertModeFlagAvailable(modeFlag, "--candidate-mode");
      modeFlag = "--candidate-mode";
      candidateMode = parseMode(argv[++index], "--candidate-mode");
    } else if (arg?.startsWith("--candidate-mode=")) {
      assertModeFlagAvailable(modeFlag, "--candidate-mode");
      modeFlag = "--candidate-mode";
      candidateMode = parseMode(arg.slice("--candidate-mode=".length), "--candidate-mode");
    } else if (arg === "--provider") {
      assertModeFlagAvailable(modeFlag, "--provider");
      modeFlag = "--provider";
      candidateMode = parseMode(argv[++index], "--provider");
      deprecations.push(legacyProviderNotice());
    } else if (arg?.startsWith("--provider=")) {
      assertModeFlagAvailable(modeFlag, "--provider");
      modeFlag = "--provider";
      candidateMode = parseMode(arg.slice("--provider=".length), "--provider");
      deprecations.push(legacyProviderNotice());
    } else if (arg === "--model") {
      if (sawModel) throw new Error("duplicate argument: --model");
      sawModel = true;
      model = requiredValue(argv[++index], "--model");
    } else if (arg?.startsWith("--model=")) {
      if (sawModel) throw new Error("duplicate argument: --model");
      sawModel = true;
      model = requiredValue(arg.slice("--model=".length), "--model");
    } else if (arg === "--repeat") {
      if (sawRepeat) throw new Error("duplicate argument: --repeat");
      sawRepeat = true;
      repeat = parseRepeat(argv[++index]);
    } else if (arg?.startsWith("--repeat=")) {
      if (sawRepeat) throw new Error("duplicate argument: --repeat");
      sawRepeat = true;
      repeat = parseRepeat(arg.slice("--repeat=".length));
    } else if (arg === "--before") {
      beforeRoot = requiredValue(argv[++index], "--before");
    } else if (arg === "--candidate") {
      candidateRoot = requiredValue(argv[++index], "--candidate");
    } else if (arg === "--case") {
      caseIds.push(requiredValue(argv[++index], "--case"));
    } else if (arg === "--price-table") {
      priceTablePath = requiredValue(argv[++index], "--price-table");
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  if (command === "compare" && (!beforeRoot || !candidateRoot)) {
    throw new Error("compare requires --before PATH and --candidate PATH");
  }
  if (model !== undefined) {
    parseModelRef(model);
  }
  if (candidateMode === "stub" && model !== undefined) {
    throw new Error("--model requires --candidate-mode real");
  }
  if (command === "preflight" && (model !== undefined || repeat !== 1)) {
    throw new Error("preflight does not accept --model or --repeat");
  }
  return {
    command,
    json,
    candidateMode,
    model,
    repeat,
    beforeRoot,
    candidateRoot,
    caseIds,
    priceTablePath,
    deprecations,
  };
}

async function runCommand(
  runner: EvalRunner,
  command: Exclude<EvalCliArgs["command"], "help">,
): Promise<EvalReport> {
  if (command === "preflight") {
    return runner.preflight();
  }
  if (command === "smoke") {
    return runner.smoke();
  }
  return runner.compare();
}

function formatEvalReport(report: EvalReport): string {
  const lines = [
    `eval=${report.eval_id} mode=${report.mode} status=${report.status}`,
    `series=${report.series_id}`,
  ];
  for (const candidate of report.candidates) {
    lines.push(
      `${candidate.label}: resolved=${candidate.resolved}/${candidate.attempted} `
        + `rate=${candidate.resolved_rate.toFixed(3)} infra=${candidate.infra_errors} safety=${candidate.safety_ok}`,
    );
  }
  lines.push(...report.concerns.map((concern) => `concern: ${concern}`));
  lines.push(...report.errors.map((error) => `error: ${error}`));
  return `${lines.join("\n")}\n`;
}

function evalHelp(): string {
  return [
    "xio eval — trusted local capability baseline",
    "",
    "Usage:",
    "  xio eval preflight [--json]",
    "  xio eval smoke [--candidate PATH] [--candidate-mode real|stub] [--model PROVIDER/MODEL] [--repeat N] [--case ID] [--json]",
    "  xio eval compare --before PATH --candidate PATH [--candidate-mode real|stub] [--model PROVIDER/MODEL] [--repeat N] [--case ID] [--json]",
    "  Compatibility: --provider real|stub is an alias for --candidate-mode (deprecated).",
    "  Add --price-table PATH (or XIO_EVAL_PRICE_TABLE) for versioned cost estimates.",
    "",
    "Real mode loads /connect credentials (or env) for the selected provider only;",
    "keys are never written to argv, reports, or candidate input.",
    `Repeat must be an integer from 1 to ${MAX_REPEAT}.`,
    "Stub mode validates controller/worktree/grader/report wiring only and never claims capability PASS.",
    "Reports are written under ~/.xiocode/evals/<eval_id>/ (or XIO_EVAL_ROOT).",
    "Credentialed series artifacts: ~/.xiocode/evals/series/<series_id>/credentialed-series.json",
    "",
  ].join("\n");
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function parseMode(value: string | undefined, flag: string): CandidateMode {
  if (value === "real" || value === "stub") {
    return value;
  }
  throw new Error(`${flag} must be real or stub`);
}

function parseRepeat(value: string | undefined): number {
  const input = requiredValue(value, "--repeat");
  if (!/^\d+$/.test(input)) {
    throw new Error(`--repeat must be an integer from 1 to ${MAX_REPEAT}`);
  }
  const parsed = Number(input);
  if (parsed < 1 || parsed > MAX_REPEAT) {
    throw new Error(`--repeat must be an integer from 1 to ${MAX_REPEAT}`);
  }
  return parsed;
}

function assertModeFlagAvailable(
  current: "--candidate-mode" | "--provider" | undefined,
  next: "--candidate-mode" | "--provider",
): void {
  if (current) {
    throw new Error(`${next} cannot be combined with ${current}`);
  }
}

function legacyProviderNotice(): string {
  return "--provider real|stub is deprecated; use --candidate-mode real|stub "
    + "(and --model provider/model for exact identity)";
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function invalidCommand(value: string): never {
  throw new Error(`unknown command: ${value}`);
}

function exitCode(status: EvalReport["status"]): number {
  if (status === "FAIL") return 2;
  if (status === "INFRA_ERROR") return 3;
  return 0;
}

function writeStdout(chunk: string): void {
  writeSync(process.stdout.fd, chunk);
}

function writeStderr(chunk: string): void {
  writeSync(process.stderr.fd, chunk);
}
