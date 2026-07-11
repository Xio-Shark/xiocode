import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { git, gitOk } from "../../extensions/xio-sandbox/src/git.ts";
import { WorktreeSandbox } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";
import { expandHome, parseXioConfig } from "./config-parser.ts";
import { ensureConfigFile } from "./ensure-config.ts";
import { setupProviderEnv } from "./env-setup.ts";

import type { WorktreeSession } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";
import type { SessionStartPayload } from "../runtime/types.ts";
import type { XioRuntimeConfig } from "./config-parser.ts";

export const XIO_VERSION = readPackageVersion();

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

export async function prepareLaunch(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { runtimeExtensionEnabled?: boolean } = {},
): Promise<LaunchPlan> {
  const ensured = await ensureConfigFile(env);
  const parsed = parseXioConfig(ensured.content, { cwd });
  const configRoot = expandHome(env.XIO_HOME ?? "~/.xiocode");
  const runtimeConfigPath = path.join(configRoot, "runtime-config.json");
  const mainRoot = await WorktreeSandbox.resolveMainRoot(cwd);
  const sourceProvenance = await collectSourceProvenance(mainRoot);
  const workspace = await createWorkspace({ mainRoot, configRoot, runtimeConfig: parsed.runtimeConfig });

  await mkdir(configRoot, { recursive: true });
  await mkdir(expandHome(parsed.xio.general.runRoot), { recursive: true });
  await writeJson(runtimeConfigPath, workspace.runtimeConfig);
  setupProviderEnv(parsed.xio.providers, env);

  return {
    runtimeConfig: workspace.runtimeConfig,
    runtimeConfigPath,
    cwd: workspace.cwd,
    mainRoot,
    worktree: workspace.worktree,
    runtimeExtensionEnabled: options.runtimeExtensionEnabled !== false,
    sessionStart: { provenance: { ...sourceProvenance, workspace_root: workspace.cwd } },
    env: {
      ...env,
      XIO_RUNTIME_CONFIG: runtimeConfigPath,
      XIO_MAIN_ROOT: mainRoot,
      ...(workspace.worktree ? { XIO_WORKTREE: workspace.worktree.worktreePath } : {}),
    },
  };
}

async function createWorkspace(input: Readonly<{
  mainRoot: string;
  configRoot: string;
  runtimeConfig: XioRuntimeConfig;
}>): Promise<{ runtimeConfig: XioRuntimeConfig; cwd: string; worktree?: WorktreeSession }> {
  if (!input.runtimeConfig.worktree.enabled) {
    return { runtimeConfig: input.runtimeConfig, cwd: input.mainRoot };
  }
  const worktree = await WorktreeSandbox.create({
    mainRoot: input.mainRoot,
    baseDir: path.join(input.configRoot, "worktrees"),
  });
  return {
    cwd: worktree.worktreePath,
    worktree,
    runtimeConfig: {
      ...input.runtimeConfig,
      worktree: { ...input.runtimeConfig.worktree, session: worktree },
    },
  };
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

function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
