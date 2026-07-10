import { writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EvalRunner } from "../../extensions/xio-eval/src/index.ts";

import type { CandidateMode, EvalReport } from "../../extensions/xio-eval/src/types.ts";

export type EvalCliArgs = Readonly<{
  command: "preflight" | "smoke" | "compare" | "help";
  json: boolean;
  candidateMode: CandidateMode;
  beforeRoot?: string;
  candidateRoot?: string;
  caseIds: readonly string[];
  priceTablePath?: string;
}>;

export async function runEvalCli(
  argv: readonly string[],
  options: Readonly<{
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    write?: (chunk: string) => void;
    trustedRoot?: string;
  }> = {},
): Promise<number> {
  const write = options.write ?? writeStdout;
  let args: EvalCliArgs;
  try {
    args = parseEvalArgs(argv);
  } catch (error) {
    write(`xio eval: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
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
  let beforeRoot: string | undefined;
  let candidateRoot: string | undefined;
  let priceTablePath: string | undefined;
  const caseIds: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--provider") {
      candidateMode = parseMode(argv[++index]);
    } else if (arg?.startsWith("--provider=")) {
      candidateMode = parseMode(arg.slice("--provider=".length));
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
  return { command, json, candidateMode, beforeRoot, candidateRoot, caseIds, priceTablePath };
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
    "  xio eval smoke [--candidate PATH] [--provider real|stub] [--case ID] [--json]",
    "  xio eval compare --before PATH --candidate PATH [--provider real|stub] [--case ID] [--json]",
    "  Add --price-table PATH (or XIO_EVAL_PRICE_TABLE) for versioned cost estimates.",
    "",
    "Stub mode validates controller/worktree/grader/report wiring only and never claims capability PASS.",
    "Reports are written under ~/.xiocode/evals/<eval_id>/ (or XIO_EVAL_ROOT).",
    "",
  ].join("\n");
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function parseMode(value: string | undefined): CandidateMode {
  if (value === "real" || value === "stub") {
    return value;
  }
  throw new Error("--provider must be real or stub");
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
