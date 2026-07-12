#!/usr/bin/env node

import { realpathSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseXioArgs } from "./cli-args.ts";
import { XIO_VERSION } from "./launch.ts";
import { runAgentCli } from "./run-agent-cli.ts";

export { parseXioArgs, shouldUseInk } from "./cli-args.ts";
export { prepareLaunch } from "./launch.ts";
export type { XioArgs } from "./cli-args.ts";
export type { LaunchPlan } from "./launch.ts";

if (isDirectRun()) {
  await main();
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "init") {
    const { ensureConfigFile } = await import("./ensure-config.ts");
    const result = await ensureConfigFile(process.env, { write: writeStdout });
    if (!result.created) {
      writeStdout(`Config already exists: ${result.path}\n`);
    }
    process.exitCode = 0;
    return;
  }
  if (rawArgs[0] === "improve") {
    const { runImproveCli } = await import("./improve-cli.ts");
    process.exitCode = await runImproveCli(rawArgs.slice(1));
    return;
  }
  if (rawArgs[0] === "eval") {
    const { runEvalCli } = await import("./eval-cli.ts");
    process.exitCode = await runEvalCli(rawArgs.slice(1));
    return;
  }
  if (rawArgs[0] === "regress") {
    const { runRegressCli } = await import("./regress-cli.ts");
    process.exitCode = await runRegressCli(rawArgs.slice(1));
    return;
  }
  if (rawArgs[0] === "models") {
    const { runModelsCli } = await import("./models-cli.ts");
    process.exitCode = await runModelsCli({
      catalogOnly: rawArgs.includes("--catalog-only"),
    });
    return;
  }

  try {
    const xioArgs = parseXioArgs(rawArgs);
    if (handleXioFlag(xioArgs.passthrough)) {
      return;
    }
    process.exitCode = await runAgentCli(xioArgs, writeStdout);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function handleXioFlag(args: readonly string[], write: (chunk: string) => void = writeStdout): boolean {
  if (args.length !== 1) {
    return false;
  }
  const [flag] = args;
  if (flag === "--version" || flag === "-v") {
    write(`XioCode ${XIO_VERSION}\n`);
    return true;
  }
  if (flag === "--help" || flag === "-h") {
    write(xioHelp());
    return true;
  }
  return false;
}

export function isDirectRunEntry(entry: string | undefined, modulePath: string = fileURLToPath(import.meta.url)): boolean {
  if (entry === undefined) {
    return false;
  }
  return realpathSync(entry) === realpathSync(modulePath);
}

function isDirectRun(): boolean {
  return isDirectRunEntry(process.argv[1]);
}

function xioHelp(): string {
  return [
    "XioCode - local-first coding agent",
    `Version: ${XIO_VERSION}`,
    "Config: ~/.xiocode/config.toml",
    "",
    "Usage:",
    "  xio                 Start the interactive Ink TUI",
    "  xio init            Create ~/.xiocode/config.toml if missing",
    "  xio -p \"prompt\"     Run a single prompt",
    "  xio resume          Resume the most recent session for this repository",
    "  xio resume <id>     Resume a specific session",
    "  xio resume --list   Choose from saved sessions",
    "  xio resume --delete <id>  Delete a saved session",
    "  xio --continue      Resume the most recent session",
    "  xio improve         Self-improve loop (worktree + verifier + merge ask)",
    "  xio eval            Trusted capability preflight/smoke/compare",
    "  xio regress         Capture / preflight / compare private regressions",
    "  xio models          List known provider/model ids (no worktree session)",
    "  xiocode             Same as xio (alias)",
    "  xio --xio-fast      Skip evolve/sandbox extensions",
    "  xio --allow-dirty   Allow worktree session when main tree is dirty",
    "  xio --version",
    "  xio --help",
    "",
    "Install once: curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash",
    "Then run xio / xiocode from any git repository.",
    "Sandbox: starts in a git worktree under ~/.xiocode/worktrees.",
    "Dirty main trees are refused by default (worktree would hide uncommitted files); use --allow-dirty or [worktree] allow_dirty = true.",
    "Merge with /merge, or answer the prompt when the session ends.",
    "Self-improve never auto-merges on green verifier — MergeGate ask only.",
    "Non-git directories are rejected (initialize a repo first).",
    "MCP servers connect in the background after the prompt is ready.",
    "Session modes: /agent build (default) | /agent plan (read-oriented tools).",
    "",
  ].join("\n");
}

function writeStdout(chunk: string): void {
  writeSync(process.stdout.fd, chunk);
}
