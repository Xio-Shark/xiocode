import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { stdin as input, stdout as output } from "node:process";

import { applyCredentialsToEnv } from "../cli/credentials.ts";
import { ExtensionHost } from "./extension-host.ts";
import { createLlmClient, resolveApiKey } from "./providers/client.ts";
import { registerConfiguredProviders, resolveDefaultModel } from "./provider-registry.ts";
import { registerConnectCommands } from "./connect-commands.ts";
import { registerThinkingCommands } from "./thinking-commands.ts";
import { registerAgentCommands } from "./agent-commands.ts";
import { registerRegressCommands } from "./regress-commands.ts";
import { registerContextCommands } from "./context-commands.ts";
import { ContextCompactionController, SessionHistory, isContextCompactionError } from "./context-compaction.ts";
import { resolveHighRiskPolicy } from "./tool-permission.ts";
import { thinkingStatusLabel } from "./thinking.ts";
import { createReadlineInteractiveIO } from "./readline-interactive.ts";
import {
  createPromptRunner,
  createSessionCloser,
  createSessionHost,
  registerMergeCommand,
  registerRollbackCommand,
} from "./session-lifecycle.ts";
import { createBuiltinTools } from "./tools/builtin.ts";
import { createStdoutSessionUiSink } from "./session-ui.ts";
import { MergeGate, defaultAsk } from "../../extensions/xio-sandbox/src/index.ts";
import { expandHome } from "../cli/config-parser.ts";

import type { InteractiveIO } from "./interactive-io.ts";
import type { ContextCompactionResult } from "./context-compaction.ts";
import type { SessionExecution } from "./session-store.ts";
import type { ChatMessage, ContextCompactionMode, ModelInfo, ProviderRegistration, SessionStartPayload, ThinkingLevel, TokenUsage, XioExtensionAPI } from "./types.ts";
import type { DoneContract } from "./verify/done-contract.ts";
import type { SessionUiSink } from "./session-ui.ts";
import type { LlmClient } from "./types.ts";
import type { AskFn } from "../../extensions/xio-sandbox/src/merge-gate.ts";
import type { XioRuntimeConfig, XioVerifyConfig } from "../cli/config-parser.ts";
import { applyThinkingLevel, cycleSessionThinkingLevel } from "./thinking-commands.ts";
import { availableThinkingLevels, clampThinkingLevel, findProviderModel } from "./thinking.ts";

export type SessionOptions = Readonly<{
  cwd?: string;
  workspaceRoot?: string;
  runtimeConfig: XioRuntimeConfig;
  registerExtensions?: (api: XioExtensionAPI) => Promise<void> | void;
  promptOnce?: string;
  /** Escape hatch for non-interactive high-risk tools (CLI/config). */
  allowHighRisk?: boolean;
  env?: NodeJS.ProcessEnv;
  ask?: (question: string) => Promise<boolean>;
  interactive?: InteractiveIO;
  maxTurns?: number;
  sessionStart?: SessionStartPayload;
  uiSink?: SessionUiSink;
  initialMessages?: readonly ChatMessage[];
  onSessionSnapshot?: (snapshot: SessionSnapshot) => Promise<void> | void;
  model?: ModelInfo;
  initialExecution?: SessionExecution;
}>;

export type SessionSnapshot = Readonly<{
  model: ModelInfo;
  messages: readonly ChatMessage[];
  execution?: SessionExecution;
  workspaceLifecycle?: "active" | "retained" | "merged" | "discarded" | "clean_removed";
}>;

export type PreparedSession = Readonly<{
  host: ExtensionHost;
  /** Live session model — prefer getModel() after /model switches. */
  model: ModelInfo;
  getModel: () => ModelInfo;
  setModel: (model: ModelInfo) => Promise<void>;
  getThinkingLevel: () => ThinkingLevel;
  cycleThinkingLevel: () => Promise<ThinkingLevel>;
  compact: (focus?: string) => Promise<ContextCompactionResult>;
  runPrompt: (prompt: string) => Promise<{
    text: string;
    success: boolean;
    turns: number;
    toolCalls: number;
    toolErrors: number;
    usage: TokenUsage;
    cancelled?: boolean;
  }>;
  /** Abort the in-flight agent turn (REPL Ctrl+C). No-op when idle. */
  abortTurn: () => void;
  getMessages: () => readonly ChatMessage[];
  close: () => Promise<void>;
}>;

export async function prepareSession(options: SessionOptions): Promise<PreparedSession> {
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = options.workspaceRoot ?? cwd;
  const env = options.env ?? process.env;
  await applyCredentialsToEnv(env, options.runtimeConfig.providers);
  const model = options.model ?? resolveDefaultModel(options.runtimeConfig);
  const verify = options.runtimeConfig.verify ?? { enabled: false, requireAllPass: true, repairTurns: 3, commands: [] };
  const ask = options.ask ?? defaultAsk;
  const sink = options.uiSink ?? createStdoutSessionUiSink();
  const interactive = options.interactive ?? createReadlineInteractiveIO(ask);
  const { host, mergeGate } = await createConfiguredHost({
    options, model, sink, ask, cwd, workspaceRoot,
  });

  let currentModel = model;
  let { client, registration } = createSessionClient({ host, model: currentModel, env });
  let parallelToolCalls = options.runtimeConfig.providers[currentModel.provider]?.parallelToolCalls ?? true;
  let turnAbort: AbortController | undefined;
  let currentExecution: SessionExecution = options.initialExecution ?? { phase: "idle" };
  let workspaceLifecycle: SessionSnapshot["workspaceLifecycle"] = "active";
  const maxSessionMessages = options.runtimeConfig.general.maxSessionMessages ?? 80;
  const history = new SessionHistory({
    initialMessages: options.initialMessages,
    persist: async (messages) => {
      await options.onSessionSnapshot?.({
        model: currentModel,
        messages,
        execution: currentExecution,
        workspaceLifecycle,
      });
    },
  });
  mergeGate?.setCheckpointClearedHandler(async () => {
    currentExecution = { phase: "idle" };
    await history.persist();
  });
  const createTurnSignal = () => {
    turnAbort = new AbortController();
    return turnAbort.signal;
  };

  const getModel = () => currentModel;
  const thinkingOpts = {
    host,
    interactive,
    sink,
    getModel,
    env,
  };
  const setModel = async (next: ModelInfo) => {
    currentModel = next;
    ({ client, registration } = createSessionClient({ host, model: currentModel, env }));
    parallelToolCalls = options.runtimeConfig.providers[currentModel.provider]?.parallelToolCalls ?? true;
    await host.setModel(currentModel);
    sink.setStatus?.("model", `${currentModel.provider}/${currentModel.id}`);
    const providerModel = findProviderModel(registration, currentModel.id);
    const clamped = clampThinkingLevel(host.getThinkingLevel(), availableThinkingLevels(providerModel));
    await applyThinkingLevel({ ...thinkingOpts, persist: false }, clamped);
    await host.emit("model_change", { provider: currentModel.provider, model: currentModel.id });
    await history.persist();
  };

  registerConnectCommands({
    host,
    interactive,
    runtimeConfig: options.runtimeConfig,
    env,
    sink,
    getModel,
    setModel,
  });
  registerThinkingCommands({
    host,
    interactive,
    sink,
    getModel,
    env,
  });
  // Agent mode filter + high-risk gate must be live before session_start so MCP hot-register respects plan/build.
  const allowHighRisk =
    options.allowHighRisk === true || options.runtimeConfig.permissions?.allowHighRisk === true;
  registerAgentCommands({
    host,
    sink,
    interactive,
    highRiskPolicy: resolveHighRiskPolicy({
      allowHighRisk,
      promptOnce: options.promptOnce,
    }),
  });
  const getRunId = async (): Promise<string | undefined> => {
    try {
      const status = await host.runCommand("status");
      if (status && typeof status === "object" && "runId" in status) {
        const id = (status as { runId?: unknown }).runId;
        return typeof id === "string" ? id : undefined;
      }
    } catch {
      return undefined;
    }
    return undefined;
  };
  registerRegressCommands({
    host,
    interactive,
    sink,
    runRoot: expandHome(options.runtimeConfig.general.runRoot),
    env,
    getRunId,
  });

  const contextCompaction = new ContextCompactionController({
    history,
    getClient: () => client,
    getModel,
    maxMessages: maxSessionMessages,
    onUiEvent: (event) => sink.onContextCompaction?.(event),
    onRuntimeEvent: async (event) => {
      try {
        await host.emit("context_compaction", event);
      } catch (error) {
        sink.notify?.(
          `Context compaction telemetry failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
  const compact = (mode: ContextCompactionMode, focus?: string) =>
    contextCompaction.compact(mode, focus, createTurnSignal());
  registerContextCommands({ host, compact });

  await host.emit("session_start", {
    ...(options.sessionStart ?? {}),
    provider: currentModel.provider,
    model: currentModel.id,
  });

  await history.persist();
  sink.setStatus?.("model", `${currentModel.provider}/${currentModel.id}`);
  sink.setStatus?.("thinking", thinkingStatusLabel(host.getThinkingLevel()));

  const session: PreparedSession = {
    host,
    get model() {
      return currentModel;
    },
    getModel,
    setModel,
    getThinkingLevel: () => host.getThinkingLevel(),
    cycleThinkingLevel: () => cycleSessionThinkingLevel(thinkingOpts),
    compact: (focus) => compact("manual", focus),
    runPrompt: createPromptRunner({
      host,
      getClient: () => client,
      getModel,
      getProviderApi: () => registration.api,
      maxTurns: options.maxTurns,
      doneContract: toDoneContract(verify),
      verify,
      getParallelToolCalls: () => parallelToolCalls,
      maxSessionMessages,
      getSignal: createTurnSignal,
      getRunId,
      beforePrompt: mergeGate ? async () => {
        const checkpoint = await mergeGate.captureTurnCheckpoint();
        currentExecution = {
          phase: "turn_started",
          turn_id: randomUUID().replaceAll("-", ""),
          checkpoint,
        };
      } : undefined,
      onCheckpoint: async (checkpoint) => {
        currentExecution = {
          phase: checkpoint.phase === "turn_complete" ? "idle" : checkpoint.phase,
          ...(currentExecution.turn_id ? { turn_id: currentExecution.turn_id } : {}),
          ...(currentExecution.checkpoint ? { checkpoint: currentExecution.checkpoint } : {}),
          ...(checkpoint.pendingTools && checkpoint.pendingTools.length > 0
            ? { pending_tools: checkpoint.pendingTools.map((tool) => ({ ...tool })) }
            : {}),
        };
        await options.onSessionSnapshot?.({
          model: currentModel,
          messages: checkpoint.messages,
          execution: currentExecution,
        });
      },
      sink,
      history,
      contextCompaction,
    }),
    close: createSessionCloser({
      host,
      mergeGate,
      ask,
      retainOnReject: options.runtimeConfig.worktree.retainOnReject,
      sink,
      onFinalized: async (disposition) => {
        workspaceLifecycle = disposition;
        if (disposition !== "retained") {
          currentExecution = { phase: "idle" };
        }
        await history.persist();
      },
    }),
    abortTurn: () => {
      turnAbort?.abort();
    },
    getMessages: () => history.getMessages(),
  };
  return session;
}

async function createConfiguredHost(input: Readonly<{
  options: SessionOptions;
  model: ModelInfo;
  sink: SessionUiSink;
  ask: AskFn;
  cwd: string;
  workspaceRoot: string;
}>): Promise<{ host: ExtensionHost; mergeGate?: MergeGate }> {
  const host = createSessionHost(
    input.model,
    input.sink,
    input.options.runtimeConfig.general.defaultThinkingLevel,
  );
  for (const tool of createBuiltinTools({ cwd: input.cwd, workspaceRoot: input.workspaceRoot })) {
    host.registerTool(tool);
  }
  registerConfiguredProviders(host, input.options.runtimeConfig);
  const worktreeSession = input.options.runtimeConfig.worktree?.session;
  const restoredCheckpoint = input.options.initialExecution?.checkpoint;
  const mergeGate = worktreeSession ? new MergeGate(worktreeSession, restoredCheckpoint) : undefined;
  await input.options.registerExtensions?.(host);
  if (mergeGate) {
    registerMergeCommand(host, mergeGate, input.ask, input.sink);
  }
  registerRollbackCommand(host, mergeGate, input.ask, input.sink);
  // session_start is emitted from prepareSession after /agent filter is installed.
  return { host, mergeGate };
}

function createSessionClient(input: Readonly<{
  host: ExtensionHost;
  model: ModelInfo;
  env: NodeJS.ProcessEnv;
}>): { client: LlmClient; registration: ProviderRegistration } {
  const registration = input.host.getProvider(input.model.provider);
  if (!registration) {
    throw new Error(
      `provider not registered: ${input.model.provider}. Run /connect or add it under [providers.*] in config.toml`,
    );
  }
  const client = createLlmClient({
    registration,
    apiKey: resolveApiKey(registration, input.env),
  });
  return { client, registration };
}

export function toDoneContract(verify: XioVerifyConfig): DoneContract | undefined {
  if (!verify.enabled || verify.commands.length === 0) {
    return undefined;
  }
  return {
    requireAllPass: verify.requireAllPass,
    commands: verify.commands.map((command) => ({
      name: command.name,
      argv: command.argv,
      cwd: command.cwd,
    })),
  };
}

export async function runSession(options: SessionOptions): Promise<number> {
  const session = await prepareSession(options);
  try {
    if (options.promptOnce !== undefined) {
      const result = await session.runPrompt(options.promptOnce);
      return result.success ? 0 : 1;
    }
    return await runRepl(session);
  } finally {
    await session.close();
  }
}

async function runRepl(session: PreparedSession): Promise<number> {
  const rl = createInterface({ input, output, terminal: true });
  let busy = false;
  const onSigInt = () => {
    if (busy) {
      session.abortTurn();
      output.write("\n^C (cancel turn — press Ctrl+C again while idle to exit)\n");
      return;
    }
    output.write("\n");
    rl.close();
    process.exit(0);
  };
  process.on("SIGINT", onSigInt);
  output.write("XioCode REPL — type a prompt, /help for commands, /exit to quit\n");
  output.write("Ctrl+C cancels the current turn; Ctrl+C again while idle exits.\n");
  try {
    for (;;) {
      const line = (await rl.question("xio> ")).trim();
      if (line.length === 0) {
        continue;
      }
      if (line === "/exit" || line === "/quit") {
        return 0;
      }
      if (line === "/help") {
        output.write("Commands: /help /compact /connect /model /thinking /agent /regress /status /merge /rollback /sandbox /exit\nSlash commands map to registered extension commands when available.\n");
        continue;
      }
      if (line.startsWith("/")) {
        const [name, ...rest] = line.slice(1).split(/\s+/);
        if (!name) {
          continue;
        }
        try {
          const result = await session.host.runCommand(name, rest.join(" "));
          if (result !== undefined) {
            output.write(`${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`);
          }
        } catch (error) {
          if (!isContextCompactionError(error)) {
            output.write(`${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
        continue;
      }
      busy = true;
      try {
        await session.runPrompt(line);
      } catch (error) {
        if (!isContextCompactionError(error)) {
          output.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      } finally {
        busy = false;
      }
    }
  } finally {
    process.off("SIGINT", onSigInt);
    rl.close();
  }
}
