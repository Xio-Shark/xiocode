import { spawn } from "node:child_process";

import { withFixHint } from "../tools/error-guidance.ts";

export type DoneCommand = Readonly<{
  name: string;
  argv: readonly string[];
  cwd?: string;
}>;

export type DoneContract = Readonly<{
  commands: readonly DoneCommand[];
  requireAllPass?: boolean;
}>;

export type DoneCommandResult = Readonly<{
  name: string;
  argv: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
}>;

export type DoneContractResult = Readonly<{
  passed: boolean;
  results: readonly DoneCommandResult[];
  summary: string;
}>;

export async function runDoneContract(
  contract: DoneContract,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<DoneContractResult> {
  if (contract.commands.length === 0) {
    return { passed: true, results: [], summary: "done contract: empty (pass)" };
  }
  const requireAllPass = contract.requireAllPass !== false;
  const results: DoneCommandResult[] = [];
  for (const command of contract.commands) {
    const result = await runCommand(command, options.cwd, options.env);
    results.push(result);
    if (!result.passed && requireAllPass) {
      break;
    }
  }
  const passed = requireAllPass ? results.every((item) => item.passed) : results.some((item) => item.passed);
  return {
    passed,
    results,
    summary: formatSummary(passed, results),
  };
}

export function formatDoneContractFeedback(result: DoneContractResult): string {
  if (result.passed) {
    return result.summary;
  }
  const failed = result.results.filter((item) => !item.passed);
  const details = failed.map((item) => {
    const out = [item.stderr.trim(), item.stdout.trim()].filter((part) => part.length > 0).join("\n");
    const body = out.length > 0
      ? `- ${item.name} (${item.argv.join(" ")}) exit=${item.exitCode}\n${out}`
      : `- ${item.name} (${item.argv.join(" ")}) exit=${item.exitCode}`;
    return body;
  }).join("\n");
  return withFixHint(
    "done",
    [
      "DONE CONTRACT FAILED. Do not claim the task is complete.",
      result.summary,
      details,
      "",
      "Next: repair root causes so each failing command exits 0, then re-check the contract.",
    ].join("\n"),
  );
}

async function runCommand(
  command: DoneCommand,
  defaultCwd: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
): Promise<DoneCommandResult> {
  const cwd = command.cwd ?? defaultCwd ?? process.cwd();
  const [bin, ...args] = command.argv;
  if (!bin) {
    return {
      name: command.name,
      argv: command.argv,
      exitCode: 1,
      stdout: "",
      stderr: "empty argv",
      passed: false,
    };
  }
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({
        name: command.name,
        argv: command.argv,
        exitCode: 1,
        stdout,
        stderr: error.message,
        passed: false,
      });
    });
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      resolve({
        name: command.name,
        argv: command.argv,
        exitCode,
        stdout: stdout.slice(0, 20_000),
        stderr: stderr.slice(0, 20_000),
        passed: exitCode === 0,
      });
    });
  });
}

function formatSummary(passed: boolean, results: readonly DoneCommandResult[]): string {
  const parts = results.map((item) => `${item.name}:${item.passed ? "pass" : `fail(${item.exitCode})`}`);
  return `done contract: ${passed ? "PASS" : "FAIL"} [${parts.join(", ")}]`;
}
