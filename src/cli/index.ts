#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync, writeSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expandHome, parseXioConfig } from "./config-parser.ts";
import { setupProviderEnv } from "./env-setup.ts";
import registerXioRuntime from "./xio-extension.ts";
import { git, gitOk } from "../../extensions/xio-sandbox/src/git.ts";
import { WorktreeSandbox } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";
import { runSession } from "../runtime/session.ts";

import type { XioRuntimeConfig } from "./config-parser.ts";
import type { WorktreeSession } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";
import type { SessionStartPayload } from "../runtime/types.ts";

const XIO_VERSION = readPackageVersion();

function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

if (isDirectRun()) {
  await main();
}

export type LaunchPlan = Readonly<{
  runtimeConfig: XioRuntimeConfig;
  runtimeConfigPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  mainRoot: string;
  worktree?: WorktreeSession;
  runtimeExtensionEnabled: boolean;
  sessionStart: SessionStartPayload;
}>;

export type XioArgs = Readonly<{
  passthrough: readonly string[];
  runtimeExtensionEnabled: boolean;
  promptOnce?: string;
}>;

export async function prepareLaunch(cwd: string, env: NodeJS.ProcessEnv = process.env, options: { runtimeExtensionEnabled?: boolean } = {}): Promise<LaunchPlan> {
  const configPath = env.XIO_CONFIG ?? path.join(os.homedir(), ".xiocode", "config.toml");
  const configContent = await readConfig(configPath);
  const parsed = parseXioConfig(configContent, { cwd });
  const configRoot = expandHome(env.XIO_HOME ?? "~/.xiocode");
  const runtimeConfigPath = path.join(configRoot, "runtime-config.json");

  const mainRoot = await WorktreeSandbox.resolveMainRoot(cwd);
  const sourceProvenance = await collectSourceProvenance(mainRoot);
  let worktree: WorktreeSession | undefined;
  let agentCwd = mainRoot;
  let runtimeConfig: XioRuntimeConfig = {
    ...parsed.runtimeConfig,
    worktree: { ...parsed.runtimeConfig.worktree },
  };

  if (runtimeConfig.worktree.enabled) {
    worktree = await WorktreeSandbox.create({
      mainRoot,
      baseDir: path.join(configRoot, "worktrees"),
    });
    agentCwd = worktree.worktreePath;
    runtimeConfig = {
      ...runtimeConfig,
      worktree: {
        ...runtimeConfig.worktree,
        session: worktree,
      },
    };
  }

  await mkdir(configRoot, { recursive: true });
  await mkdir(expandHome(parsed.xio.general.runRoot), { recursive: true });
  await writeJson(runtimeConfigPath, runtimeConfig);
  setupProviderEnv(parsed.xio.providers, env);
  const sessionStart: SessionStartPayload = {
    provenance: { ...sourceProvenance, workspace_root: agentCwd },
  };

  return {
    runtimeConfig,
    runtimeConfigPath,
    cwd: agentCwd,
    mainRoot,
    worktree,
    runtimeExtensionEnabled: options.runtimeExtensionEnabled !== false,
    sessionStart,
    env: {
      ...env,
      XIO_RUNTIME_CONFIG: runtimeConfigPath,
      XIO_MAIN_ROOT: mainRoot,
      ...(worktree ? { XIO_WORKTREE: worktree.worktreePath } : {}),
    },
  };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
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

  const xioArgs = parseXioArgs(rawArgs);
  try {
    if (handleXioFlag(xioArgs.passthrough)) {
      return;
    }
    const launch = await prepareLaunch(process.cwd(), process.env, { runtimeExtensionEnabled: xioArgs.runtimeExtensionEnabled });
    const code = await runSession({
      cwd: launch.cwd,
      workspaceRoot: launch.cwd,
      runtimeConfig: launch.runtimeConfig,
      env: launch.env,
      promptOnce: xioArgs.promptOnce,
      sessionStart: launch.sessionStart,
      registerExtensions: launch.runtimeExtensionEnabled
        ? async (api) => {
          process.env.XIO_RUNTIME_CONFIG = launch.runtimeConfigPath;
          await registerXioRuntime(api);
        }
        : undefined,
    });
    process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function collectSourceProvenance(
  mainRoot: string,
): Promise<NonNullable<SessionStartPayload["provenance"]>> {
  const [baseCommit, status, branch] = await Promise.all([
    gitOk(mainRoot, ["rev-parse", "HEAD"]),
    gitOk(mainRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(mainRoot, ["symbolic-ref", "--short", "HEAD"]),
  ]);
  return {
    schema_version: "xio-run-provenance.v1",
    workspace_root: mainRoot,
    main_root: mainRoot,
    base_commit: baseCommit,
    branch: branch.code === 0 && branch.stdout.length > 0 ? branch.stdout : null,
    dirty: status.length > 0,
    dirty_summary_sha: createHash("sha256").update(status).digest("hex"),
    xiocode_revision: XIO_VERSION,
    created_at: new Date().toISOString(),
  };
}

export function parseXioArgs(args: readonly string[]): XioArgs {
  const runtimeExtensionEnabled = !args.includes("--xio-fast");
  const withoutFast = args.filter((arg) => arg !== "--xio-fast");
  let promptOnce: string | undefined;
  const passthrough: string[] = [];
  for (let i = 0; i < withoutFast.length; i += 1) {
    const arg = withoutFast[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "-p" || arg === "--prompt") {
      promptOnce = withoutFast[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--prompt=")) {
      promptOnce = arg.slice("--prompt=".length);
      continue;
    }
    passthrough.push(arg);
  }
  return { passthrough, runtimeExtensionEnabled, promptOnce };
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

async function readConfig(configPath: string): Promise<string> {
  try {
    return await readFile(expandHome(configPath), "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function xioHelp(): string {
  return [
    "XioCode - local-first coding agent",
    `Version: ${XIO_VERSION}`,
    "Config: ~/.xiocode/config.toml",
    "",
    "Usage:",
    "  xio                 Start interactive REPL",
    "  xio -p \"prompt\"     Run a single prompt",
    "  xio improve         Self-improve loop (worktree + verifier + merge ask)",
    "  xio eval            Trusted capability preflight/smoke/compare",
    "  xio regress         Capture and preflight a private local regression",
    "  xio --xio-fast      Skip evolve/sandbox extensions",
    "  xio --version",
    "  xio --help",
    "",
    "Sandbox: starts in a git worktree under ~/.xiocode/worktrees.",
    "Merge with /merge, or answer the prompt when the session ends.",
    "Self-improve never auto-merges on green verifier — MergeGate ask only.",
    "Non-git directories are rejected (initialize a repo first).",
    "",
  ].join("\n");
}

function writeStdout(chunk: string): void {
  writeSync(process.stdout.fd, chunk);
}
