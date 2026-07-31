import { writeSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTrustedCapabilityGate } from "../../extensions/xio-eval/src/index.ts";
import { candidateRevision } from "../../extensions/xio-eval/src/evidence.ts";
import { loadRetrospectiveImproveGoals } from "../../extensions/xio-evolve/src/index.ts";
import {
  BUILTIN_SEEDS,
  createPrivateRegressionGate,
  GoalStore,
  ImprovementRunService,
  RepeatedFailureStop,
  RunLedgerStore,
  SelfImproveRunner,
} from "../../extensions/xio-improve/src/index.ts";
import {
  InvalidRegressionCaseError,
  RegressionCaseStore,
} from "../../extensions/xio-regress/src/index.ts";
import { defaultAsk, WorktreeSandbox } from "../../extensions/xio-sandbox/src/index.ts";
import { expandHome, parseXioConfig } from "./config-parser.ts";

import type { XioImproveConfig } from "./config-parser.ts";
import type { ImproveGoal, ImprovementRunState } from "../../extensions/xio-improve/src/index.ts";

export type ImproveCliCommand = "run" | "status" | "resume" | "retry" | "abandon";

export type ImproveCliArgs = Readonly<{
  command: ImproveCliCommand;
  runId?: string;
  json: boolean;
  overrideReason?: string;
  abandonReason?: string;
  max: number;
  help: boolean;
  verifierCommands: readonly string[];
  noBuiltinSeeds: boolean;
  capabilityGate: boolean;
  /** True when `--capability-gate` appeared on the CLI (overrides config). */
  capabilityGateFromFlag: boolean;
  privateCaseId?: string;
  /** True when `--private-case` appeared on the CLI (overrides config). */
  privateCaseFromFlag: boolean;
  /** Trial repeats per fixture for the capability gate (1-10). Default 1. */
  evalRepeat: number;
  /** True when `--eval-repeat` appeared on the CLI (overrides config). */
  evalRepeatFromFlag: boolean;
}>;

/**
 * `xio improve` / `bin/xio-improve` entry.
 * Always uses WorktreeSandbox + MergeGate ask; never auto-merges on green.
 */
export async function runImproveCli(
  argv: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    ask?: (question: string) => Promise<boolean>;
    write?: (chunk: string) => void;
    improveConfig?: XioImproveConfig;
  } = {},
): Promise<number> {
  const write = options.write ?? writeStdout;
  let parsed: ImproveCliArgs;
  try {
    parsed = parseImproveArgs(argv);
  } catch (error) {
    write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (parsed.help) {
    write(improveHelp());
    return 0;
  }

  const env = options.env ?? process.env;
  const improveConfig = options.improveConfig ?? await loadImproveConfig(env);
  let resolved: ImproveCliArgs;
  try {
    resolved = await resolveImproveArgs(parsed, improveConfig, env);
  } catch (error) {
    write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (resolved.privateCaseId && !resolved.capabilityGate) {
    write(
      "error: private_case requires capability_gate "
        + "(set --capability-gate or [improve] capability_gate = true; joint FIXED × PASS)\n",
    );
    return 2;
  }

  const cwd = options.cwd ?? process.cwd();
  try {
    await assertMaintainerRepo(cwd);
  } catch (error) {
    write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const xioHome = env.XIO_HOME ? expandHome(env.XIO_HOME) : path.join(os.homedir(), ".xiocode");
  const ledger = new ImprovementRunService({
    store: new RunLedgerStore({ root: path.join(xioHome, "improve", "runs") }),
    revisionOf: candidateRevision,
  });

  if (resolved.command === "status") {
    return runStatusCommand(ledger, resolved, write);
  }
  if (resolved.command === "abandon") {
    return runAbandonCommand(ledger, resolved, { cwd, env, write, ask: options.ask ?? defaultAsk });
  }
  if (resolved.command === "resume") {
    return runResumeCommand(ledger, resolved, { cwd, env, write, ask: options.ask ?? defaultAsk });
  }
  if (resolved.command === "retry") {
    return runRetryCommand(ledger, resolved, { cwd, env, write, ask: options.ask ?? defaultAsk, xioHome });
  }

  const runner = await createRunner({
    parsed: resolved,
    cwd,
    env,
    ask: options.ask ?? defaultAsk,
    write,
    ledger,
    xioHome,
  });

  write(
    `Self-improve: T4 schedule, verifier default npm run check, merge via MergeGate ask only (never auto-merge on green).\n`,
  );

  if (resolved.max <= 1) {
    const result = await runner.runOnce();
    if (!result) {
      write("No goals to run.\n");
      return 1;
    }
    write(formatResult(result));
    return result.verifier.ok && gatesPassed(result) ? 0 : 2;
  }

  const results = await runner.runLoop({ max: resolved.max });
  if (results.length === 0) {
    write("No goals to run.\n");
    return 1;
  }
  for (const result of results) {
    write(formatResult(result));
  }
  return results.every((result) => result.verifier.ok && gatesPassed(result)) ? 0 : 2;
}

/** Expected package identity of the XioCode source repository. */
export const MAINTAINER_PACKAGE_NAME = "@xioshark/xiocode";

/**
 * Maintainer-mode guard (parent PRD R6.3, maintainer-only MVP): `xio improve`
 * edits XioCode source, so the git main root must be the XioCode repository.
 * Fails closed on missing/malformed package.json or identity mismatch.
 */
export async function assertMaintainerRepo(cwd: string): Promise<string> {
  const mainRoot = await WorktreeSandbox.resolveMainRoot(cwd);
  const packagePath = path.join(mainRoot, "package.json");
  let detected: string;
  try {
    const parsed: unknown = JSON.parse(await readFile(packagePath, "utf8"));
    const name = parsed && typeof parsed === "object" && "name" in parsed ? parsed.name : undefined;
    detected = typeof name === "string" && name.length > 0 ? name : "<missing name>";
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    detected = code === "ENOENT" ? "<no package.json>" : "<unreadable package.json>";
  }
  if (detected !== MAINTAINER_PACKAGE_NAME) {
    throw new Error(
      `xio improve is maintainer self-improve for the XioCode source repository `
        + `(expected package "${MAINTAINER_PACKAGE_NAME}", detected "${detected}" at ${mainRoot}). `
        + `Run it from a XioCode checkout; generic project improvement is not supported.`,
    );
  }
  return mainRoot;
}

async function createRunner(options: Readonly<{
  parsed: ImproveCliArgs;
  cwd: string;
  env: NodeJS.ProcessEnv;
  ask: (question: string) => Promise<boolean>;
  write: (chunk: string) => void;
  ledger: ImprovementRunService;
  xioHome: string;
  claimOptions?: Readonly<{ retryOf?: string; overrideReason?: string }>;
  retryGoal?: ImproveGoal;
}>): Promise<SelfImproveRunner> {
  const { parsed, cwd, env, xioHome } = options;
  const goalStore = new GoalStore({ loadBuiltinSeeds: !parsed.noBuiltinSeeds && !options.retryGoal });
  if (options.retryGoal) {
    goalStore.enqueue(options.retryGoal);
  } else {
    // Prefer post-task retrospective goals (from evolve) over seeds when present.
    const retroGoals = await loadRetrospectiveImproveGoals(path.join(xioHome, "improve", "queue"));
    for (const goal of retroGoals) {
      goalStore.enqueue(goal as ImproveGoal);
    }
    if (retroGoals.length > 0) {
      options.write(`Loaded ${retroGoals.length} retrospective improve goal(s) from ~/.xiocode/improve/queue\n`);
    }
  }
  return new SelfImproveRunner({
    mainRoot: cwd,
    goalStore,
    worktreeBaseDir: path.join(xioHome, "worktrees"),
    // Extras only; Verifier always prepends default `npm run check`.
    verifierCommands: parsed.verifierCommands,
    ask: options.ask,
    notify: (message) => options.write(`${message}\n`),
    ledger: options.ledger,
    ...(options.claimOptions ? { claimOptions: options.claimOptions } : {}),
    spawnXio: async (prompt, worktreePath) => {
      const { spawnImproveAgent } = await import("./improve-agent.ts");
      await spawnImproveAgent(prompt, worktreePath, { mainRoot: cwd, env });
    },
    capabilityGate: parsed.capabilityGate
      ? createTrustedCapabilityGate({
        trustedRoot: cwd,
        evalRoot: env.XIO_EVAL_ROOT,
        priceTablePath: env.XIO_EVAL_PRICE_TABLE,
        repeat: parsed.evalRepeat,
        env,
      })
      : undefined,
    privateCaseId: parsed.privateCaseId,
    privateGate: parsed.privateCaseId
      ? createPrivateRegressionGate({ env })
      : undefined,
  });
}

type SubcommandContext = Readonly<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  write: (chunk: string) => void;
  ask: (question: string) => Promise<boolean>;
}>;

async function runStatusCommand(
  ledger: ImprovementRunService,
  parsed: ImproveCliArgs,
  write: (chunk: string) => void,
): Promise<number> {
  try {
    const states = parsed.runId ? [await ledger.load(parsed.runId)] : await ledger.list();
    if (states.length === 0) {
      write(parsed.json ? "[]\n" : "No improvement runs recorded.\n");
      return 0;
    }
    const projections = [];
    for (const state of states) {
      const continuation = await ledger.continuation(state, {
        worktreeExists: async (target) => access(target).then(() => true, () => false),
      });
      projections.push({ state, continuation });
    }
    if (parsed.json) {
      write(`${JSON.stringify(projections.map(({ state, continuation }) => ({
        run_id: state.run_id,
        goal: state.goal,
        attempt: state.attempt,
        parent_run_id: state.parent_run_id,
        phase: continuation.phase,
        disposition: continuation.disposition,
        outcome: continuation.outcome,
        next_action: continuation.next_action,
        blockers: continuation.blockers,
        stale_evidence: continuation.stale_evidence,
        candidate: state.candidate,
        evidence: state.evidence,
        updated_at: state.updated_at,
      })), null, 2)}\n`);
      return 0;
    }
    for (const { state, continuation } of projections) {
      write(formatRunStatus(state, continuation.next_action, continuation.stale_evidence));
    }
    return 0;
  } catch (error) {
    write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function formatRunStatus(
  state: ImprovementRunState,
  nextAction: string,
  staleEvidence: readonly string[],
): string {
  return [
    `run=${state.run_id} attempt=${state.attempt}${state.parent_run_id ? ` parent=${state.parent_run_id}` : ""}`,
    `  goal=${state.goal.id} source=${state.goal.source} title=${JSON.stringify(state.goal.title)}`,
    `  phase=${state.phase} disposition=${state.disposition}${state.outcome ? ` outcome=${state.outcome}` : ""}`,
    `  next: ${nextAction}`,
    ...(staleEvidence.length > 0 ? [`  stale: ${staleEvidence.join("; ")}`] : []),
    "",
  ].join("\n");
}

async function runResumeCommand(
  ledger: ImprovementRunService,
  parsed: ImproveCliArgs,
  context: SubcommandContext,
): Promise<number> {
  const runId = parsed.runId;
  if (!runId) {
    context.write("error: resume requires a RUN id\n");
    return 2;
  }
  try {
    const xioHome = context.env.XIO_HOME ? expandHome(context.env.XIO_HOME) : path.join(os.homedir(), ".xiocode");
    const runner = await createRunner({
      parsed,
      cwd: context.cwd,
      env: context.env,
      ask: context.ask,
      write: context.write,
      ledger,
      xioHome,
    });
    const result = await runner.resumeRun(runId);
    context.write(formatResult(result));
    return result.verifier.ok && gatesPassed(result) ? 0 : 2;
  } catch (error) {
    context.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

async function runRetryCommand(
  ledger: ImprovementRunService,
  parsed: ImproveCliArgs,
  context: SubcommandContext & Readonly<{ xioHome: string }>,
): Promise<number> {
  const runId = parsed.runId;
  if (!runId) {
    context.write("error: retry requires a RUN id\n");
    return 2;
  }
  try {
    const state = await ledger.load(runId);
    const goal = await resolveGoalForRetry(state, context.xioHome);
    const runner = await createRunner({
      parsed,
      cwd: context.cwd,
      env: context.env,
      ask: context.ask,
      write: context.write,
      ledger,
      xioHome: context.xioHome,
      retryGoal: goal,
      claimOptions: {
        retryOf: runId,
        ...(parsed.overrideReason ? { overrideReason: parsed.overrideReason } : {}),
      },
    });
    const result = await runner.runOnce();
    if (!result) {
      context.write("error: retry produced no run (goal was skipped)\n");
      return 2;
    }
    context.write(formatResult(result));
    return result.verifier.ok && gatesPassed(result) ? 0 : 2;
  } catch (error) {
    if (error instanceof RepeatedFailureStop) {
      context.write(`error: ${error.message}\n`);
      return 2;
    }
    context.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

/** Rebuild the goal from its durable source ref; never from run state prose. */
async function resolveGoalForRetry(state: ImprovementRunState, xioHome: string): Promise<ImproveGoal> {
  if (state.goal.source === "seed") {
    const seed = BUILTIN_SEEDS.find((entry) => entry.id === state.goal.id);
    if (!seed) {
      throw new Error(`seed goal ${state.goal.id} is no longer available in BUILTIN_SEEDS`);
    }
    return seed;
  }
  if ((state.goal.source === "queue" || state.goal.source === "external_eval") && state.goal.source_ref) {
    const queueRoot = path.join(xioHome, "improve", "queue");
    const goals = await loadRetrospectiveImproveGoals(queueRoot);
    const goal = goals.find((entry) => entry.id === state.goal.id);
    if (!goal) {
      throw new Error(
        `queue goal ${state.goal.id} (${state.goal.source_ref}) is no longer present in ${queueRoot}`,
      );
    }
    return goal as ImproveGoal;
  }
  throw new Error(
    `cannot rebuild goal ${state.goal.id} (source=${state.goal.source}); re-run xio improve with the original source available`,
  );
}

async function runAbandonCommand(
  ledger: ImprovementRunService,
  parsed: ImproveCliArgs,
  context: SubcommandContext,
): Promise<number> {
  const runId = parsed.runId;
  if (!runId) {
    context.write("error: abandon requires a RUN id\n");
    return 2;
  }
  try {
    const state = await ledger.load(runId);
    if (state.phase === "terminal") {
      context.write(`error: run ${runId} is already terminal (${state.outcome ?? "unknown"})\n`);
      return 2;
    }
    const release = await ledger.store.acquireLock(runId);
    try {
      await ledger.terminate(state, {
        outcome: "abandoned",
        reason: parsed.abandonReason ?? "abandoned_via_cli",
      });
    } finally {
      await release();
    }
    context.write(`Run ${runId} abandoned. Worktree (if any) is kept for inspection.\n`);
    return 0;
  } catch (error) {
    context.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

export function parseImproveArgs(argv: readonly string[]): ImproveCliArgs {
  let command: ImproveCliCommand = "run";
  let runId: string | undefined;
  let json = false;
  let overrideReason: string | undefined;
  let abandonReason: string | undefined;
  let max = 1;
  let help = false;
  let noBuiltinSeeds = false;
  let capabilityGate = false;
  let capabilityGateFromFlag = false;
  let privateCaseId: string | undefined;
  let privateCaseFromFlag = false;
  let evalRepeat = 1;
  let evalRepeatFromFlag = false;
  const verifierCommands: string[] = [];

  let index = 0;
  const first = argv[0];
  if (first !== undefined && !first.startsWith("-")) {
    if (!["status", "resume", "retry", "abandon"].includes(first)) {
      throw new Error(`unknown improve subcommand: ${first}`);
    }
    command = first as ImproveCliCommand;
    index = 1;
    const second = argv[1];
    if (second !== undefined && !second.startsWith("-")) {
      runId = second;
      index = 2;
    }
    if (command !== "status" && runId === undefined) {
      throw new Error(`${command} requires a RUN id (see: xio improve status)`);
    }
  }

  for (let i = index; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--override-reason") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("missing value for --override-reason");
      }
      overrideReason = value;
      i += 1;
      continue;
    }
    if (arg === "--reason") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("missing value for --reason");
      }
      abandonReason = value;
      i += 1;
      continue;
    }
    if (arg === "--max") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("missing value for --max");
      }
      i += 1;
      const parsedMax = Number.parseInt(value, 10);
      if (!Number.isFinite(parsedMax) || parsedMax < 1) {
        throw new Error(`invalid --max value: ${value}`);
      }
      max = parsedMax;
      continue;
    }
    if (arg.startsWith("--max=")) {
      const raw = arg.slice("--max=".length);
      const parsedMax = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsedMax) || parsedMax < 1) {
        throw new Error(`invalid --max value: ${raw}`);
      }
      max = parsedMax;
      continue;
    }
    if (arg === "--check") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("missing value for --check");
      }
      i += 1;
      verifierCommands.push(value);
      continue;
    }
    if (arg === "--no-builtin-seeds") {
      noBuiltinSeeds = true;
      continue;
    }
    if (arg === "--capability-gate") {
      capabilityGate = true;
      capabilityGateFromFlag = true;
      continue;
    }
    if (arg === "--private-case") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("missing value for --private-case");
      }
      privateCaseId = value;
      privateCaseFromFlag = true;
      i += 1;
      continue;
    }
    if (arg.startsWith("--private-case=")) {
      const value = arg.slice("--private-case=".length);
      if (!value) {
        throw new Error("missing value for --private-case");
      }
      privateCaseId = value;
      privateCaseFromFlag = true;
      continue;
    }
    if (arg === "--eval-repeat") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("missing value for --eval-repeat");
      }
      evalRepeat = parseEvalRepeat(value);
      evalRepeatFromFlag = true;
      i += 1;
      continue;
    }
    if (arg.startsWith("--eval-repeat=")) {
      evalRepeat = parseEvalRepeat(arg.slice("--eval-repeat=".length));
      evalRepeatFromFlag = true;
      continue;
    }
    throw new Error(`unknown improve option: ${arg}`);
  }

  return {
    command,
    json,
    max,
    help,
    verifierCommands,
    noBuiltinSeeds,
    capabilityGate,
    capabilityGateFromFlag,
    privateCaseFromFlag,
    evalRepeat,
    evalRepeatFromFlag,
    ...(runId ? { runId } : {}),
    ...(overrideReason ? { overrideReason } : {}),
    ...(abandonReason ? { abandonReason } : {}),
    ...(privateCaseId ? { privateCaseId } : {}),
  };
}

/** Apply `[improve]` config when matching CLI flags were omitted; resolve `private_case=last`. */
export async function resolveImproveArgs(
  parsed: ImproveCliArgs,
  config: XioImproveConfig,
  env: NodeJS.ProcessEnv = process.env,
  store: RegressionCaseStore = new RegressionCaseStore(env.XIO_REGRESSION_ROOT),
): Promise<ImproveCliArgs> {
  const capabilityGate = parsed.capabilityGateFromFlag ? parsed.capabilityGate : config.capabilityGate;
  const evalRepeat = parsed.evalRepeatFromFlag ? parsed.evalRepeat : config.evalRepeat ?? parsed.evalRepeat;
  let privateCaseId = parsed.privateCaseFromFlag ? parsed.privateCaseId : config.privateCase;
  if (privateCaseId) {
    try {
      privateCaseId = await store.resolvePrivateCaseId(privateCaseId);
    } catch (error) {
      if (error instanceof InvalidRegressionCaseError) {
        throw new Error(error.message);
      }
      throw error;
    }
  }
  return {
    ...parsed,
    capabilityGate,
    evalRepeat,
    ...(privateCaseId ? { privateCaseId } : {}),
  };
}

/** Mirror `xio eval --repeat` bounds (1-10). */
function parseEvalRepeat(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("--eval-repeat must be an integer between 1 and 10");
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > 10) {
    throw new Error("--eval-repeat must be an integer between 1 and 10");
  }
  return parsed;
}

async function loadImproveConfig(env: NodeJS.ProcessEnv): Promise<XioImproveConfig> {
  const configPath = expandHome(env.XIO_CONFIG ?? path.join(os.homedir(), ".xiocode", "config.toml"));
  try {
    const content = await readFile(configPath, "utf8");
    return parseXioConfig(content).xio.improve;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return { capabilityGate: false };
    }
    throw error;
  }
}

function formatResult(result: {
  goal: { id: string; source: string; title: string };
  verifier: { ok: boolean; exitCode: number };
  capabilityGate?: { status: string; evalId?: string };
  privateGate?: { status: string; caseId: string };
  merge: { asked: boolean; approved?: boolean; merged?: boolean; reason?: string };
}): string {
  const merge = result.merge;
  let mergeLine: string;
  if (!merge.asked) {
    mergeLine = `merge=not-asked (${"reason" in merge ? merge.reason : "n/a"})`;
  } else if (merge.approved === false) {
    mergeLine = "merge=asked-rejected (main tree unchanged)";
  } else if (merge.merged) {
    mergeLine = "merge=approved-merged";
  } else {
    mergeLine = "merge=approved-failed";
  }
  return [
    `goal=${result.goal.id} source=${result.goal.source} title=${JSON.stringify(result.goal.title)}`,
    `verifier=${result.verifier.ok ? "green" : "red"} exit=${result.verifier.exitCode}`,
    result.privateGate
      ? `private_gate=${result.privateGate.status} case=${result.privateGate.caseId}`
      : "private_gate=disabled",
    result.capabilityGate
      ? `capability_gate=${result.capabilityGate.status} eval=${result.capabilityGate.evalId ?? "n/a"}`
      : "capability_gate=disabled",
    mergeLine,
    "",
  ].join("\n");
}

function improveHelp(): string {
  return [
    "xio improve — self-modification outer loop",
    "",
    "Usage:",
    "  xio improve                 Run one goal (T4: queue → red_test → seed)",
    "  xio improve --max N         Run up to N goals",
    "  xio improve status [RUN] [--json]",
    "                              Show durable improvement runs and next actions",
    "  xio improve resume RUN      Validate and continue an interrupted run",
    "                              (never replays the agent automatically)",
    "  xio improve retry RUN [--override-reason TEXT]",
    "                              New attempt for a terminal run (keeps lineage)",
    "  xio improve abandon RUN [--reason TEXT]",
    "                              Terminal abandon; worktree kept for inspection",
    "  xio improve --check CMD     Append verifier command (default: npm run check)",
    "  xio improve --capability-gate  Require trusted before/after PASS before merge ask",
    "  xio improve --eval-repeat N Trial repeats per fixture for the capability gate (1-10; default 1)",
    "  xio improve --private-case ID --capability-gate",
    "                              Joint gate: private FIXED × trusted PASS before merge ask",
    "                              ID may be a case id or \"last\" (reads ~/.xiocode/regressions/.last-case)",
    "  xio improve --no-builtin-seeds",
    "  xio improve --help",
    "",
    "Config defaults ([improve] in config.toml, overridden by CLI flags):",
    "  capability_gate = true|false",
    "  private_case = \"last\" | \"<64-hex-id>\"",
    "  eval_repeat = 1..10",
    "",
    "Policy:",
    "  Maintainer-only: refuses to run unless the git main root is the XioCode",
    "  source repository (package @xioshark/xiocode); no generic-project mode.",
    "  Edits run inside WorktreeSandbox.",
    "  Green verifier triggers MergeGate ask only — never auto-merge.",
    "  With --capability-gate, FAIL/INFRA/CONCERNS do not ask to merge.",
    "  With --private-case, FIXED alone never asks; requires --capability-gate + PASS.",
    "  Red verifier does not ask to merge.",
    "  Private cases are joint-gate evidence only — not ImproveGoal inputs.",
    "",
  ].join("\n");
}

function gatesPassed(result: {
  capabilityGate?: { status: string };
  privateGate?: { status: string };
}): boolean {
  if (result.privateGate && result.privateGate.status !== "FIXED") return false;
  if (result.capabilityGate && result.capabilityGate.status !== "PASS") return false;
  return true;
}

function writeStdout(chunk: string): void {
  writeSync(process.stdout.fd, chunk);
}
