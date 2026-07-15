import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { git, gitOk } from "../../extensions/xio-sandbox/src/git.ts";
import { WorktreeSandbox } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";
import { expandHome, parseXioConfig } from "./config-parser.ts";
import { ensureConfigFile } from "./ensure-config.ts";
import { setupProviderEnv } from "./env-setup.ts";
import { applyCredentialsToEnv } from "./credentials.ts";
import { XIO_VERSION } from "./version.ts";

import type { WorktreeSession } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";
import type { SessionStartPayload } from "../runtime/types.ts";
import type { SessionWorkspace } from "../runtime/session-store.ts";
import type { XioRuntimeConfig } from "./config-parser.ts";

export { XIO_VERSION };

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
  options: {
    runtimeExtensionEnabled?: boolean;
    allowDirty?: boolean;
    sessionId?: string;
    resumeWorkspace?: SessionWorkspace;
    /** Pre-resolved git toplevel when caller already looked it up (avoids duplicate git). */
    gitRoot?: string | null;
  } = {},
): Promise<LaunchPlan> {
  const ensured = await ensureConfigFile(env);
  const parsed = parseXioConfig(ensured.content, { cwd });
  const configRoot = expandHome(env.XIO_HOME ?? "~/.xiocode");
  const runtimeConfigPath = path.join(configRoot, "runtime-config.json");
  // Launch directory is the user-visible workspace (not forced to git toplevel).
  const workspacePath = path.resolve(cwd);
  const worktreeEnabled = parsed.runtimeConfig.worktree.enabled;
  const gitRoot = options.gitRoot !== undefined
    ? options.gitRoot
    : await WorktreeSandbox.tryResolveMainRoot(workspacePath);

  if (worktreeEnabled && !gitRoot) {
    throw new Error(
      [
        "XioCode worktree mode requires a git repository.",
        `Started in: ${workspacePath}`,
        "Initialize with `git init` (and an initial commit), or set `[worktree] enabled = false`",
        "to run directly in the current directory without a sandbox worktree.",
      ].join("\n"),
    );
  }

  // mainRoot: git toplevel when available; otherwise the launch cwd.
  const mainRoot = gitRoot ?? workspacePath;
  const sourceProvenance = await collectSourceProvenance(mainRoot, workspacePath, Boolean(gitRoot));
  const allowDirty = options.allowDirty === true || parsed.runtimeConfig.worktree.allowDirty;
  assertDirtyMainPolicy({
    worktreeEnabled,
    dirty: sourceProvenance.dirty,
    allowDirty,
    mainRoot,
  });
  const workspace = await createWorkspace({
    mainRoot,
    workspacePath,
    configRoot,
    runtimeConfig: parsed.runtimeConfig,
    sessionId: options.sessionId,
    resumeWorkspace: options.resumeWorkspace,
  });

  await mkdir(configRoot, { recursive: true });
  await mkdir(expandHome(parsed.xio.general.runRoot), { recursive: true });
  await writeJson(runtimeConfigPath, workspace.runtimeConfig);
  await applyCredentialsToEnv(env, parsed.xio.providers);
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

export function assertDirtyMainPolicy(input: Readonly<{
  worktreeEnabled: boolean;
  dirty: boolean;
  allowDirty: boolean;
  mainRoot: string;
}>): void {
  if (!input.worktreeEnabled || !input.dirty || input.allowDirty) {
    return;
  }
  throw new Error(
    [
      "XioCode refused to start: the main git tree has uncommitted changes.",
      `Main tree: ${input.mainRoot}`,
      "Worktree sessions check out a clean HEAD and would ignore your dirty files.",
      "Commit/stash your changes, or opt in with `xio --allow-dirty` or `[worktree] allow_dirty = true`.",
      "Or set `[worktree] enabled = false` to work directly in the current directory.",
    ].join("\n"),
  );
}

async function createWorkspace(input: Readonly<{
  mainRoot: string;
  workspacePath: string;
  configRoot: string;
  runtimeConfig: XioRuntimeConfig;
  sessionId?: string;
  resumeWorkspace?: SessionWorkspace;
}>): Promise<{ runtimeConfig: XioRuntimeConfig; cwd: string; worktree?: WorktreeSession }> {
  if (input.resumeWorkspace?.mode === "worktree" && !input.runtimeConfig.worktree.enabled) {
    throw new Error("saved session requires worktree mode, but worktree.enabled is false");
  }
  if (!input.runtimeConfig.worktree.enabled) {
    // Main mode: stay in the directory the user launched from.
    return { runtimeConfig: input.runtimeConfig, cwd: input.workspacePath };
  }
  const baseDir = path.join(input.configRoot, "worktrees");
  const resumed = toStoredWorktree(input.resumeWorkspace, input.mainRoot);
  const worktree = resumed
    ? await WorktreeSandbox.attach(resumed, { baseDir })
    : await WorktreeSandbox.create({ mainRoot: input.mainRoot, baseDir, sessionId: input.sessionId });
  return {
    cwd: worktree.worktreePath,
    worktree,
    runtimeConfig: {
      ...input.runtimeConfig,
      worktree: { ...input.runtimeConfig.worktree, session: worktree },
    },
  };
}

function toStoredWorktree(workspace: SessionWorkspace | undefined, mainRoot: string): WorktreeSession | undefined {
  if (!workspace || workspace.mode !== "worktree") return undefined;
  if (workspace.lifecycle !== "active" && workspace.lifecycle !== "retained") {
    throw new Error(`saved worktree is not resumable: ${workspace.lifecycle}`);
  }
  if (path.resolve(workspace.main_root) !== path.resolve(mainRoot)) {
    throw new Error(`saved worktree belongs to another repository: ${workspace.main_root}`);
  }
  const fields = {
    mainRoot: workspace.main_root,
    worktreePath: workspace.worktree_path,
    branch: workspace.branch,
    sessionId: workspace.session_id,
    repoId: workspace.repo_id,
    baseRef: workspace.base_ref,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (!value) throw new Error(`saved worktree is missing ${key}`);
  }
  // baseline_tree is optional for legacy v2; attach materializes baseRef^{tree} when absent.
  return {
    ...fields,
    baselineTree: workspace.baseline_tree ?? "",
  } as WorktreeSession;
}

async function collectSourceProvenance(
  mainRoot: string,
  workspacePath: string,
  isGit: boolean,
): Promise<NonNullable<SessionStartPayload["provenance"]>> {
  if (!isGit) {
    return {
      schema_version: "xio-run-provenance.v1",
      workspace_root: workspacePath,
      main_root: mainRoot,
      base_commit: "nogit",
      branch: null,
      dirty: false,
      dirty_summary_sha: createHash("sha256").update("nogit").digest("hex"),
      xiocode_revision: XIO_VERSION,
      created_at: new Date().toISOString(),
    };
  }

  const [baseCommit, status, branch] = await Promise.all([
    gitOk(mainRoot, ["rev-parse", "HEAD"]),
    gitOk(mainRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(mainRoot, ["symbolic-ref", "--short", "HEAD"]),
  ]);
  return {
    schema_version: "xio-run-provenance.v1",
    workspace_root: workspacePath,
    main_root: mainRoot,
    base_commit: baseCommit,
    branch: branch.code === 0 && branch.stdout.length > 0 ? branch.stdout : null,
    dirty: status.length > 0,
    dirty_summary_sha: createHash("sha256").update(status).digest("hex"),
    xiocode_revision: XIO_VERSION,
    created_at: new Date().toISOString(),
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
