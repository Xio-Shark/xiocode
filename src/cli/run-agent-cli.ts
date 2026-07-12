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
      const stored = await store.load(xioArgs.resume.id);
      if (stored.workspace?.mode === "worktree" && stored.workspace.session_id) {
        await WorktreeSandbox.releaseSessionCheckpoints({
          mainRoot: stored.workspace.main_root,
          sessionId: stored.workspace.session_id,
        });
      }
      await store.remove(xioArgs.resume.id);
    } finally {
      await releaseLease();
    }
    write(`Deleted session ${xioArgs.resume.id}\n`);
    return 0;
  }
  const mainRoot = await WorktreeSandbox.resolveMainRoot(process.cwd());
  const stored = await loadRequestedSession({ xioArgs, mainRoot, store });
  if (xioArgs.resume?.action === "list" && !stored) {
    return 0;
  }
  const recovered = recoverStoredSession(stored);
  const sessionId = stored?.metadata.id ?? store.createId();
  const releaseLease = await store.acquireLease(sessionId);
  try {
    const launch = await prepareLaunch(process.cwd(), process.env, {
      runtimeExtensionEnabled: xioArgs.runtimeExtensionEnabled,
      allowDirty: xioArgs.allowDirty,
      sessionId: recovered && !recovered.filesRecoverable ? undefined : sessionId,
      resumeWorkspace: recovered?.filesRecoverable ? recovered.workspace : undefined,
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

function createExtensionRegistrar(launch: LaunchPlan): SessionOptions["registerExtensions"] {
  if (!launch.runtimeExtensionEnabled) return undefined;
  return async (api) => {
    process.env.XIO_RUNTIME_CONFIG = launch.runtimeConfigPath;
    await registerXioRuntime(api);
  };
}
