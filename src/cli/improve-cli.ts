import { writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTrustedCapabilityGate } from "../../extensions/xio-eval/src/index.ts";
import {
  createPrivateRegressionGate,
  GoalStore,
  SelfImproveRunner,
} from "../../extensions/xio-improve/src/index.ts";
import {
  InvalidRegressionCaseError,
  RegressionCaseStore,
} from "../../extensions/xio-regress/src/index.ts";
import { defaultAsk } from "../../extensions/xio-sandbox/src/index.ts";
import { expandHome, parseXioConfig } from "./config-parser.ts";

import type { XioImproveConfig } from "./config-parser.ts";

export type ImproveCliArgs = Readonly<{
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
  const parsed = parseImproveArgs(argv);
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
  const runner = createRunner({ parsed: resolved, cwd, env, ask: options.ask ?? defaultAsk, write });

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

function createRunner(options: Readonly<{
  parsed: ImproveCliArgs;
  cwd: string;
  env: NodeJS.ProcessEnv;
  ask: (question: string) => Promise<boolean>;
  write: (chunk: string) => void;
}>): SelfImproveRunner {
  const { parsed, cwd, env } = options;
  const xioHome = env.XIO_HOME ? expandHome(env.XIO_HOME) : path.join(os.homedir(), ".xiocode");
  return new SelfImproveRunner({
    mainRoot: cwd,
    goalStore: new GoalStore({ loadBuiltinSeeds: !parsed.noBuiltinSeeds }),
    worktreeBaseDir: path.join(xioHome, "worktrees"),
    verifierCommands: parsed.verifierCommands.length > 0 ? parsed.verifierCommands : undefined,
    ask: options.ask,
    notify: (message) => options.write(`${message}\n`),
    capabilityGate: parsed.capabilityGate
      ? createTrustedCapabilityGate({
        trustedRoot: cwd,
        evalRoot: env.XIO_EVAL_ROOT,
        priceTablePath: env.XIO_EVAL_PRICE_TABLE,
        env,
      })
      : undefined,
    privateCaseId: parsed.privateCaseId,
    privateGate: parsed.privateCaseId
      ? createPrivateRegressionGate({ env })
      : undefined,
  });
}

export function parseImproveArgs(argv: readonly string[]): ImproveCliArgs {
  let max = 1;
  let help = false;
  let noBuiltinSeeds = false;
  let capabilityGate = false;
  let capabilityGateFromFlag = false;
  let privateCaseId: string | undefined;
  let privateCaseFromFlag = false;
  const verifierCommands: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--max") {
      const value = argv[i + 1];
      i += 1;
      max = Math.max(1, Number.parseInt(value ?? "1", 10) || 1);
      continue;
    }
    if (arg.startsWith("--max=")) {
      max = Math.max(1, Number.parseInt(arg.slice("--max=".length), 10) || 1);
      continue;
    }
    if (arg === "--check") {
      const value = argv[i + 1];
      i += 1;
      if (value) {
        verifierCommands.push(value);
      }
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
      privateCaseId = argv[i + 1];
      privateCaseFromFlag = true;
      i += 1;
      continue;
    }
    if (arg.startsWith("--private-case=")) {
      privateCaseId = arg.slice("--private-case=".length);
      privateCaseFromFlag = true;
      continue;
    }
  }

  return {
    max,
    help,
    verifierCommands,
    noBuiltinSeeds,
    capabilityGate,
    capabilityGateFromFlag,
    privateCaseFromFlag,
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
    ...(privateCaseId ? { privateCaseId } : {}),
  };
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
    "  xio improve --check CMD     Append verifier command (default: npm run check)",
    "  xio improve --capability-gate  Require trusted before/after PASS before merge ask",
    "  xio improve --private-case ID --capability-gate",
    "                              Joint gate: private FIXED × trusted PASS before merge ask",
    "                              ID may be a case id or \"last\" (reads ~/.xiocode/regressions/.last-case)",
    "  xio improve --no-builtin-seeds",
    "  xio improve --help",
    "",
    "Config defaults ([improve] in config.toml, overridden by CLI flags):",
    "  capability_gate = true|false",
    "  private_case = \"last\" | \"<64-hex-id>\"",
    "",
    "Policy:",
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
