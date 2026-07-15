import path from "node:path";

import { WorktreeSandbox } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";
import { runSession } from "../runtime/session.ts";
import registerXioRuntime from "./xio-extension.ts";
import { prepareLaunch } from "./launch.ts";
import { shouldUseInk } from "./cli-args.ts";
import { createSessionStore, resolveResume } from "./session-resume.ts";
import { recoverStoredSession } from "../runtime/session-recovery.ts";

import type { SessionOptions } from "../runtime/session.ts";
import type { SessionStore, StoredSession } from "../runtime/session-store.ts";
import type { XioArgs } from "./cli-args.ts";
import type { LaunchPlan } from "./launch.ts";

export async function runAgentCli(xioArgs: XioArgs, write: (chunk: string) => void): Promise<number> {
  const store = createSessionStore(process.env);
  if (xioArgs.resume?.action === "delete") {
    const releaseLease = await store.acquireLease(xioArgs.resume.id);
    try {
      await deleteStoredSession(store, xioArgs.resume.id);
    } finally {
      await releaseLease();
    }
    write(`Deleted session ${xioArgs.resume.id}\n`);
    return 0;
  }
  // Resolve git root once for resume lookup + prepareLaunch (no duplicate provenance git).
  const cwd = process.cwd();
  const gitRoot = await WorktreeSandbox.tryResolveMainRoot(cwd);
  const mainRoot = gitRoot ?? path.resolve(cwd);
  const stored = await loadRequestedSession({ xioArgs, mainRoot, store });
  if (xioArgs.resume?.action === "list" && !stored) {
    return 0;
  }
  const recovered = recoverStoredSession(stored);
  const sessionId = stored?.metadata.id ?? store.createId();
  const releaseLease = await store.acquireLease(sessionId);
  try {
    const launch = await prepareLaunch(cwd, process.env, {
      runtimeExtensionEnabled: xioArgs.runtimeExtensionEnabled,
      allowDirty: xioArgs.allowDirty,
      sessionId: recovered && !recovered.filesRecoverable ? undefined : sessionId,
      resumeWorkspace: recovered?.filesRecoverable ? recovered.workspace : undefined,
      gitRoot,
    });
    if (launch.worktree && recovered?.filesRecoverable && recovered.execution?.checkpoint) {
      await WorktreeSandbox.validateCheckpoint(launch.worktree, recovered.execution.checkpoint);
    }
    return await runPreparedLaunch({ xioArgs, launch, store, stored, recovered, sessionId });
  } finally {
    await releaseLease();
  }
}

async function loadRequestedSession(input: Readonly<{
  xioArgs: XioArgs;
  mainRoot: string;
  store: SessionStore;
}>): Promise<StoredSession | undefined> {
  return resolveResume({
    store: input.store,
    request: input.xioArgs.resume,
    mainRoot: input.mainRoot,
    select: async (sessions) => (await import("../tui/session-picker.ts")).runSessionPicker(sessions),
  });
}

async function runPreparedLaunch(input: Readonly<{
  xioArgs: XioArgs;
  launch: LaunchPlan;
  store: SessionStore;
  stored?: StoredSession;
  recovered?: ReturnType<typeof recoverStoredSession>;
  sessionId: string;
}>): Promise<number> {
  const sessionOptions: SessionOptions = {
    cwd: input.launch.cwd,
    workspaceRoot: input.launch.cwd,
    runtimeConfig: input.launch.runtimeConfig,
    env: input.launch.env,
    promptOnce: input.xioArgs.promptOnce,
    allowHighRisk: input.xioArgs.allowHighRisk,
    sessionStart: input.launch.sessionStart,
    initialMessages: input.recovered?.messages ?? input.stored?.messages,
    initialExecution: input.recovered?.execution,
    model: restoredModel(input.stored),
    onSessionSnapshot: (snapshot) => input.store.save({
      id: input.sessionId,
      model: snapshot.model,
      cwd: input.launch.cwd,
      mainRoot: input.launch.mainRoot,
      worktreePath: input.launch.worktree?.worktreePath,
      messages: snapshot.messages,
      workspace: input.launch.worktree ? {
        mode: "worktree",
        lifecycle: snapshot.workspaceLifecycle ?? "active",
        main_root: input.launch.worktree.mainRoot,
        worktree_path: input.launch.worktree.worktreePath,
        branch: input.launch.worktree.branch,
        base_ref: input.launch.worktree.baseRef,
        baseline_tree: input.launch.worktree.baselineTree,
        repo_id: input.launch.worktree.repoId,
        session_id: input.launch.worktree.sessionId,
        epoch: input.recovered?.workspace?.epoch ?? 0,
      } : {
        mode: "main",
        lifecycle: snapshot.workspaceLifecycle ?? "active",
        main_root: input.launch.mainRoot,
        epoch: input.recovered?.workspace?.epoch ?? 0,
      },
      execution: snapshot.execution,
      createdAt: input.stored?.metadata.created_at,
      durability: snapshot.durability ?? "snapshot",
    }).then(() => undefined),
    registerExtensions: createExtensionRegistrar(input.launch),
  };
  return shouldUseInk(input.xioArgs)
    ? (await import("../tui/run-ink-session.ts")).runInkSession(sessionOptions)
    : runSession(sessionOptions);
}

function restoredModel(stored: StoredSession | undefined): SessionOptions["model"] {
  if (!stored) return undefined;
  return {
    provider: stored.metadata.model.provider,
    id: stored.metadata.model.id,
    name: stored.metadata.model.id,
  };
}

/**
 * Delete session metadata only after associated Git resources are cleaned.
 * active/retained worktree sessions must remove the registered worktree, branch,
 * and checkpoint refs; identity mismatch fails closed without deleting metadata.
 */
export async function deleteStoredSession(store: SessionStore, id: string): Promise<void> {
  const stored = await store.load(id);
  const workspace = stored.workspace;

  if (workspace?.mode === "worktree" && workspace.session_id && workspace.main_root) {
    const mainRoot = workspace.main_root;
    const sessionId = workspace.session_id;
    const lifecycle = workspace.lifecycle;

    if (lifecycle === "active" || lifecycle === "retained") {
      const session = {
        mainRoot,
        worktreePath: workspace.worktree_path,
        branch: workspace.branch,
        sessionId,
        repoId: workspace.repo_id,
        baseRef: workspace.base_ref,
        baselineTree: workspace.baseline_tree ?? "",
      };
      for (const [key, value] of Object.entries(session)) {
        if (key === "baselineTree") continue;
        if (!value) {
          throw new Error(`session delete refused: worktree identity incomplete (${key})`);
        }
      }
      // Attach validates repo id, path, branch, and registration — fail closed on mismatch.
      const attached = await WorktreeSandbox.attach(
        session as import("../../extensions/xio-sandbox/src/worktree-sandbox.ts").WorktreeSession,
      );
      await WorktreeSandbox.remove(attached, { force: true });
    }

    // All worktree sessions clear checkpoint refs before metadata deletion.
    await WorktreeSandbox.releaseSessionCheckpoints({ mainRoot, sessionId });
  }

  await store.remove(id);
}

function createExtensionRegistrar(launch: LaunchPlan): SessionOptions["registerExtensions"] {
  if (!launch.runtimeExtensionEnabled) return undefined;
  return async (api) => {
    process.env.XIO_RUNTIME_CONFIG = launch.runtimeConfigPath;
    await registerXioRuntime(api);
  };
}
