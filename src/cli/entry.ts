#!/usr/bin/env node

/**
 * Production CLI entry — keep the static import graph minimal.
 * Do not re-export launch/session/tui modules from this file.
 */

import { realpathSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { XIO_VERSION } from "./version.ts";
import { handleXioFlag } from "./router-help.ts";

if (isDirectRun()) {
  await main();
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Fast path before any dynamic import (including perf origin mark).
  if (rawArgs.length === 1 && handleXioFlag(rawArgs, writeStdout)) {
    return;
  }

  const { markProcessOrigin } = await import("../runtime/perf/tracer.ts");
  markProcessOrigin();

  const head = rawArgs[0];
  if (head === "init") {
    const { ensureConfigFile } = await import("./ensure-config.ts");
    const result = await ensureConfigFile(process.env, { write: writeStdout });
    if (!result.created) {
      writeStdout(`Config already exists: ${result.path}\n`);
      const { formatRecommendedCliToolsNotice } = await import("../runtime/tools/search-backend.ts");
      writeStdout(`\n${await formatRecommendedCliToolsNotice()}`);
    }
    process.exitCode = 0;
    return;
  }
  if (head === "improve") {
    const { runImproveCli } = await import("./improve-cli.ts");
    process.exitCode = await runImproveCli(rawArgs.slice(1));
    return;
  }
  if (head === "eval") {
    const { runEvalCli } = await import("./eval-cli.ts");
    process.exitCode = await runEvalCli(rawArgs.slice(1));
    return;
  }
  if (head === "regress") {
    const { runRegressCli } = await import("./regress-cli.ts");
    process.exitCode = await runRegressCli(rawArgs.slice(1));
    return;
  }
  if (head === "bench") {
    const { runBenchCli } = await import("./bench-cli.ts");
    process.exitCode = await runBenchCli(rawArgs.slice(1));
    return;
  }
  if (head === "models") {
    const { runModelsCli } = await import("./models-cli.ts");
    process.exitCode = await runModelsCli({
      catalogOnly: rawArgs.includes("--catalog-only"),
    });
    return;
  }

  try {
    const { parseXioArgs } = await import("./cli-args.ts");
    const xioArgs = parseXioArgs(rawArgs);
    if (handleXioFlag(xioArgs.passthrough, writeStdout)) {
      return;
    }
    const interactive = xioArgs.promptOnce === undefined;
    if (interactive && process.stdout.isTTY) {
      writeStdout(`XioCode ${XIO_VERSION} · starting…\n`);
    }
    // Boot chrome / entry readiness = first_frame; prompt_ready is after prepareSession.
    if (interactive && (process.env.XIO_PERF === "1" || process.env.XIO_PERF_BOOT_EXIT === "1")) {
      const { getGlobalTracer } = await import("../runtime/perf/tracer.ts");
      getGlobalTracer()?.mark("first_frame", "success", {
        attrs: { ui: process.stdout.isTTY ? "boot_shell" : "boot_shell_notty" },
      });
    }
    const { runAgentCli } = await import("./run-agent-cli.ts");
    const code = await runAgentCli(xioArgs, writeStdout);
    const { exitCli } = await import("./process-exit.ts");
    exitCli(code ?? 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    const { exitCli } = await import("./process-exit.ts");
    exitCli(1);
  }
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

function writeStdout(chunk: string): void {
  writeSync(process.stdout.fd, chunk);
}


