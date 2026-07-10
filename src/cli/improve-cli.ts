import { writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { GoalStore, SelfImproveRunner } from "../../extensions/xio-improve/src/index.ts";
import { defaultAsk } from "../../extensions/xio-sandbox/src/index.ts";

export type ImproveCliArgs = Readonly<{
  max: number;
  help: boolean;
  verifierCommands: readonly string[];
  noBuiltinSeeds: boolean;
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
  } = {},
): Promise<number> {
  const write = options.write ?? writeStdout;
  const parsed = parseImproveArgs(argv);
  if (parsed.help) {
    write(improveHelp());
    return 0;
  }

  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const worktreeBaseDir = path.join(env.XIO_HOME ? expandHome(env.XIO_HOME) : path.join(os.homedir(), ".xiocode"), "worktrees");

  const goalStore = new GoalStore({ loadBuiltinSeeds: !parsed.noBuiltinSeeds });
  const runner = new SelfImproveRunner({
    mainRoot: cwd,
    goalStore,
    worktreeBaseDir,
    verifierCommands: parsed.verifierCommands.length > 0 ? parsed.verifierCommands : undefined,
    ask: options.ask ?? defaultAsk,
    notify: (message) => write(`${message}\n`),
  });

  write(
    `Self-improve: T4 schedule, verifier default npm run check, merge via MergeGate ask only (never auto-merge on green).\n`,
  );

  if (parsed.max <= 1) {
    const result = await runner.runOnce();
    if (!result) {
      write("No goals to run.\n");
      return 1;
    }
    write(formatResult(result));
    return result.verifier.ok ? 0 : 2;
  }

  const results = await runner.runLoop({ max: parsed.max });
  if (results.length === 0) {
    write("No goals to run.\n");
    return 1;
  }
  for (const result of results) {
    write(formatResult(result));
  }
  return results.every((r) => r.verifier.ok) ? 0 : 2;
}

export function parseImproveArgs(argv: readonly string[]): ImproveCliArgs {
  let max = 1;
  let help = false;
  let noBuiltinSeeds = false;
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
  }

  return { max, help, verifierCommands, noBuiltinSeeds };
}

function formatResult(result: {
  goal: { id: string; source: string; title: string };
  verifier: { ok: boolean; exitCode: number };
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
    "  xio improve --no-builtin-seeds",
    "  xio improve --help",
    "",
    "Policy:",
    "  Edits run inside WorktreeSandbox.",
    "  Green verifier triggers MergeGate ask only — never auto-merge.",
    "  Red verifier does not ask to merge.",
    "",
  ].join("\n");
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function writeStdout(chunk: string): void {
  writeSync(process.stdout.fd, chunk);
}
