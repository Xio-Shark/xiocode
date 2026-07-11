import { WorktreeSandbox } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";
import { runSession } from "../runtime/session.ts";
import registerXioRuntime from "./xio-extension.ts";
import { prepareLaunch } from "./launch.ts";
import { shouldUseInk } from "./cli-args.ts";
import { createSessionStore, resolveResume } from "./session-resume.ts";

import type { SessionOptions } from "../runtime/session.ts";
import type { SessionStore, StoredSession } from "../runtime/session-store.ts";
import type { XioArgs } from "./cli-args.ts";
import type { LaunchPlan } from "./launch.ts";

export async function runAgentCli(xioArgs: XioArgs, write: (chunk: string) => void): Promise<number> {
  const store = createSessionStore(process.env);
  if (xioArgs.resume?.action === "delete") {
    await store.remove(xioArgs.resume.id);
    write(`Deleted session ${xioArgs.resume.id}\n`);
    return 0;
  }
  const launch = await prepareLaunch(process.cwd(), process.env, {
    runtimeExtensionEnabled: xioArgs.runtimeExtensionEnabled,
  });
  const stored = await loadRequestedSession({ xioArgs, launch, store });
  if (xioArgs.resume?.action === "list" && !stored) {
    await discardUnusedLaunch(launch);
    return 0;
  }
  return runPreparedLaunch({ xioArgs, launch, store, stored });
}

async function loadRequestedSession(input: Readonly<{
  xioArgs: XioArgs;
  launch: LaunchPlan;
  store: SessionStore;
}>): Promise<StoredSession | undefined> {
  try {
    return await resolveResume({
      store: input.store,
      request: input.xioArgs.resume,
      mainRoot: input.launch.mainRoot,
      select: async (sessions) => (await import("../tui/session-picker.ts")).runSessionPicker(sessions),
    });
  } catch (error) {
    await discardUnusedLaunch(input.launch);
    throw error;
  }
}

async function runPreparedLaunch(input: Readonly<{
  xioArgs: XioArgs;
  launch: LaunchPlan;
  store: SessionStore;
  stored?: StoredSession;
}>): Promise<number> {
  const sessionId = input.stored?.metadata.id ?? input.store.createId();
  const sessionOptions: SessionOptions = {
    cwd: input.launch.cwd,
    workspaceRoot: input.launch.cwd,
    runtimeConfig: input.launch.runtimeConfig,
    env: input.launch.env,
    promptOnce: input.xioArgs.promptOnce,
    sessionStart: input.launch.sessionStart,
    initialMessages: input.stored?.messages,
    model: restoredModel(input.stored),
    onSessionSnapshot: (snapshot) => input.store.save({
      id: sessionId,
      model: snapshot.model,
      cwd: input.launch.cwd,
      mainRoot: input.launch.mainRoot,
      worktreePath: input.launch.worktree?.worktreePath,
      messages: snapshot.messages,
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

async function discardUnusedLaunch(launch: LaunchPlan): Promise<void> {
  if (launch.worktree) await WorktreeSandbox.remove(launch.worktree, { force: true });
}
