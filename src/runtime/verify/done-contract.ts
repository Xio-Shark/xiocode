import { withFixHint } from "../tools/error-guidance.ts";
import { buildChildEnv } from "../secret-environment.ts";
import { kernelSessionIfAvailable, OUTPUT_BUDGET_PRESETS, runSupervisedProcessGated } from "../process/index.ts";
import { describeEvidence, EVIDENCE_EVENT, evidenceKey, withoutStatCaches, type CommandEvidence } from "./evidence.ts";

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
  /** Kernel path: whether an earlier pass was kept instead of running again, and why or why not. */
  evidence?: CommandEvidence;
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
    summary: formatSummary(passed, results, options.cwd ?? process.cwd()),
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
  // An earlier pass stands only while the kernel says it still describes the workspace.
  const session = await kernelSessionIfAvailable(cwd);
  const key = evidenceKey(command.argv, cwd);
  const last = session?.listFacts(EVIDENCE_EVENT).filter((fact) => fact.payload.key === key).at(-1);
  const previous = session && last?.payload.passed === true && typeof last.payload.opId === "string"
    ? session.evidenceStatus(last.payload.opId)
    : undefined;
  if (previous?.status === "fresh") {
    return { name: command.name, argv: command.argv, exitCode: 0, stdout: "", stderr: "", passed: true, evidence: { reused: true, previous } };
  }

  const cacheFree = withoutStatCaches(command.argv, env ?? buildChildEnv(process.env));
  const result = await runSupervisedProcessGated({
    command: bin,
    args,
    cwd,
    env: cacheFree.env,
    trackReads: { roots: [cwd], ...(cacheFree.statCaches ? { statCaches: cacheFree.statCaches } : {}) },
    timeoutMs: 10 * 60 * 1000,
    output: {
      ...OUTPUT_BUDGET_PRESETS.verify,
      headBytes: 20_000,
      tailBytes: 0,
      hardCapBytes: 512 * 1024,
    },
  }).finally(cacheFree.dispose);
  const exitCode = result.code ?? 1;
  if (session && result.kernel && !result.kernel.indeterminate) {
    session.recordFact(EVIDENCE_EVENT, { key, opId: result.kernel.opId, name: command.name, passed: exitCode === 0 }, { opId: result.kernel.opId });
  }
  return {
    name: command.name,
    argv: command.argv,
    exitCode,
    stdout: result.stdout.slice(0, 20_000),
    stderr: result.stderr.slice(0, 20_000),
    passed: exitCode === 0,
    ...(session ? { evidence: { reused: false, ...(previous ? { previous } : {}) } } : {}),
  };
}

function formatSummary(passed: boolean, results: readonly DoneCommandResult[], cwd: string): string {
  const parts = results.map((item) =>
    `${item.name}:${item.passed ? "pass" : `fail(${item.exitCode})`}${describeEvidence(item.evidence, cwd)}`);
  return `done contract: ${passed ? "PASS" : "FAIL"} [${parts.join(", ")}]`;
}
