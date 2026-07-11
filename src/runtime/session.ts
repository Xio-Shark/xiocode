import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { ExtensionHost } from "./extension-host.ts";
import { createLlmClient, resolveApiKey } from "./providers/client.ts";
import { registerConfiguredProviders, resolveDefaultModel } from "./provider-registry.ts";
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

import type { ChatMessage, ModelInfo, ProviderRegistration, SessionStartPayload, TokenUsage, XioExtensionAPI } from "./types.ts";
import type { DoneContract } from "./verify/done-contract.ts";
import type { SessionUiSink } from "./session-ui.ts";
import type { LlmClient } from "./types.ts";
import type { AskFn } from "../../extensions/xio-sandbox/src/merge-gate.ts";
import type { XioRuntimeConfig, XioVerifyConfig } from "../cli/config-parser.ts";

export type SessionOptions = Readonly<{
  cwd?: string;
  workspaceRoot?: string;
  runtimeConfig: XioRuntimeConfig;
  registerExtensions?: (api: XioExtensionAPI) => Promise<void> | void;
  promptOnce?: string;
  env?: NodeJS.ProcessEnv;
  ask?: (question: string) => Promise<boolean>;
  maxTurns?: number;
  sessionStart?: SessionStartPayload;
  uiSink?: SessionUiSink;
  initialMessages?: readonly ChatMessage[];
  onSessionSnapshot?: (snapshot: SessionSnapshot) => Promise<void> | void;
  model?: ModelInfo;
}>;

export type SessionSnapshot = Readonly<{
  model: ModelInfo;
  messages: readonly ChatMessage[];
}>;

export type PreparedSession = Readonly<{
  host: ExtensionHost;
  model: ModelInfo;
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
  const model = options.model ?? resolveDefaultModel(options.runtimeConfig);
  const verify = options.runtimeConfig.verify ?? { enabled: false, requireAllPass: true, repairTurns: 3, commands: [] };
  const ask = options.ask ?? defaultAsk;
  const sink = options.uiSink ?? createStdoutSessionUiSink();
  const { host, mergeGate } = await createConfiguredHost({
    options, model, sink, ask, cwd, workspaceRoot,
  });
  const { client, registration } = createSessionClient({ host, model, env });
  const providerConfig = options.runtimeConfig.providers[model.provider];
  let turnAbort: AbortController | undefined;
  let sessionMessages = options.initialMessages ? [...options.initialMessages] : [];
  await options.onSessionSnapshot?.({ model, messages: sessionMessages });

  return {
    host,
    model,
    runPrompt: createPromptRunner({
      host,
      client,
      model,
      providerApi: registration.api,
      maxTurns: options.maxTurns,
      doneContract: toDoneContract(verify),
      verify,
      parallelToolCalls: providerConfig?.parallelToolCalls ?? true,
      maxSessionMessages: options.runtimeConfig.general.maxSessionMessages ?? 80,
      getSignal: () => {
        turnAbort = new AbortController();
        return turnAbort.signal;
      },
      beforePrompt: mergeGate ? () => mergeGate.captureTurnCheckpoint() : undefined,
      sink,
      initialMessages: sessionMessages,
      onMessagesChanged: async (messages) => {
        sessionMessages = [...messages];
        await options.onSessionSnapshot?.({ model, messages });
      },
    }),
    close: createSessionCloser({
      host, mergeGate, ask, retainOnReject: options.runtimeConfig.worktree.retainOnReject, sink,
    }),
    abortTurn: () => {
      turnAbort?.abort();
    },
    getMessages: () => [...sessionMessages],
  };
}

async function createConfiguredHost(input: Readonly<{
  options: SessionOptions;
  model: ModelInfo;
  sink: SessionUiSink;
  ask: AskFn;
  cwd: string;
  workspaceRoot: string;
}>): Promise<{ host: ExtensionHost; mergeGate?: MergeGate }> {
  const host = createSessionHost(input.model, input.sink);
  for (const tool of createBuiltinTools({ cwd: input.cwd, workspaceRoot: input.workspaceRoot })) {
    host.registerTool(tool);
  }
  registerConfiguredProviders(host, input.options.runtimeConfig);
  const worktreeSession = input.options.runtimeConfig.worktree?.session;
  const mergeGate = worktreeSession ? new MergeGate(worktreeSession) : undefined;
  await input.options.registerExtensions?.(host);
  if (mergeGate) {
    registerMergeCommand(host, mergeGate, input.ask, input.sink);
  }
  registerRollbackCommand(host, mergeGate, input.ask, input.sink);
  await host.emit("session_start", input.options.sessionStart ?? {});
  return { host, mergeGate };
}

function createSessionClient(input: Readonly<{
  host: ExtensionHost;
  model: ModelInfo;
  env: NodeJS.ProcessEnv;
}>): { client: LlmClient; registration: ProviderRegistration } {
  const registration = input.host.getProvider(input.model.provider);
  if (!registration) {
    throw new Error(`provider not registered: ${input.model.provider}. Add it under [providers.*] in config.toml`);
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
        output.write("Commands: /help /status /merge /rollback /sandbox /exit\nSlash commands map to registered extension commands when available.\n");
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
          output.write(`${error instanceof Error ? error.message : String(error)}\n`);
        }
        continue;
      }
      busy = true;
      try {
        await session.runPrompt(line);
      } catch (error) {
        output.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        busy = false;
      }
    }
  } finally {
    process.off("SIGINT", onSigInt);
    rl.close();
  }
}
