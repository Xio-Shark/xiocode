import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runSession } from "../runtime/session.ts";
import { expandHome, parseXioConfig } from "./config-parser.ts";
import { ensureConfigFile } from "./ensure-config.ts";
import { applyCredentialsToEnv } from "./credentials.ts";
import { setupProviderEnv } from "./env-setup.ts";
import { registerRuntimeFromConfig } from "./xio-extension.ts";

import type { XioRuntimeConfig } from "./config-parser.ts";

/**
 * Run the real xio agent once inside an existing candidate worktree.
 * Runtime config has no active worktree session, so the agent does not create a
 * nested worktree or open an inner MergeGate ask — the outer SelfImproveRunner owns merge.
 */
export async function spawnImproveAgent(
  prompt: string,
  worktreePath: string,
  options: Readonly<{
    mainRoot: string;
    env?: NodeJS.ProcessEnv;
  }>,
): Promise<void> {
  const env = { ...options.env ?? process.env };
  const ensured = await ensureConfigFile(env);
  const parsed = parseXioConfig(ensured.content, { cwd: options.mainRoot });
  const runtimeConfig: XioRuntimeConfig = {
    ...parsed.runtimeConfig,
    // No session → no nested sandbox / MergeGate inside the agent session.
    worktree: {
      ...parsed.runtimeConfig.worktree,
      enabled: false,
      session: undefined,
    },
  };

  await applyCredentialsToEnv(env, parsed.xio.providers);
  setupProviderEnv(parsed.xio.providers, env);

  const configRoot = expandHome(env.XIO_HOME ?? path.join(os.homedir(), ".xiocode"));
  const exitCode = await runSession({
    cwd: worktreePath,
    workspaceRoot: worktreePath,
    runtimeConfig,
    env: {
      ...env,
      XIO_MAIN_ROOT: options.mainRoot,
      XIO_WORKTREE: worktreePath,
    },
    promptOnce: prompt,
    // Decline any incidental prompts; outer SelfImproveRunner owns the real merge ask.
    ask: async () => false,
    registerExtensions: (api) => registerRuntimeFromConfig(api, runtimeConfig, {
      workspaceCwd: worktreePath,
      home: os.homedir(),
      configRoot,
    }),
  });

  if (exitCode !== 0) {
    throw new Error(`improve agent finished with exit code ${exitCode}`);
  }
}

/** Optional helper for tests that need a parsed runtime without writing disk. */
export async function loadImproveRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<XioRuntimeConfig> {
  const configPath = expandHome(env.XIO_CONFIG ?? path.join(os.homedir(), ".xiocode", "config.toml"));
  try {
    const content = await readFile(configPath, "utf8");
    return parseXioConfig(content, { cwd }).runtimeConfig;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      const ensured = await ensureConfigFile(env);
      return parseXioConfig(ensured.content, { cwd }).runtimeConfig;
    }
    throw error;
  }
}
