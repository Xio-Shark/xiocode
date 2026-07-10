import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { runAgentLoop } from "./agent-loop.ts";
import { ExtensionHost } from "./extension-host.ts";
import { createLlmClient, resolveApiKey } from "./providers/client.ts";
import { createBuiltinTools } from "./tools/builtin.ts";
import { MergeGate, defaultAsk } from "../../extensions/xio-sandbox/src/index.ts";

import type { ModelInfo, ProviderRegistration, XioExtensionAPI } from "./types.ts";
import type { DoneContract } from "./verify/done-contract.ts";
import type { XioRuntimeConfig, XioVerifyConfig } from "../cli/config-parser.ts";

export type SessionOptions = Readonly<{
  cwd?: string;
  workspaceRoot?: string;
  runtimeConfig: XioRuntimeConfig;
  registerExtensions?: (api: XioExtensionAPI) => Promise<void> | void;
  promptOnce?: string;
  env?: NodeJS.ProcessEnv;
  ask?: (question: string) => Promise<boolean>;
}>;

export type PreparedSession = Readonly<{
  host: ExtensionHost;
  model: ModelInfo;
  runPrompt: (prompt: string) => Promise<{ text: string; success: boolean }>;
  close: () => Promise<void>;
}>;

export async function prepareSession(options: SessionOptions): Promise<PreparedSession> {
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = options.workspaceRoot ?? cwd;
  const env = options.env ?? process.env;
  const model = resolveDefaultModel(options.runtimeConfig);
  const verify = options.runtimeConfig.verify ?? { enabled: false, requireAllPass: true, repairTurns: 3, commands: [] };
  const doneContract = toDoneContract(verify);
  const ask = options.ask ?? defaultAsk;
  const host = new ExtensionHost({
    initialModel: model,
    ui: {
      notify(message, level) {
        const prefix = level ? `[${level}] ` : "";
        output.write(`${prefix}${message}\n`);
      },
      setStatus(key, text) {
        if (text) {
          output.write(`[status:${key}] ${text}\n`);
        }
      },
      setWidget(_key, content) {
        if (content && content.length > 0) {
          output.write(`${content.join("\n")}\n`);
        }
      },
    },
  });

  for (const tool of createBuiltinTools({ cwd, workspaceRoot })) {
    host.registerTool(tool);
  }

  registerConfiguredProviders(host, options.runtimeConfig);

  const worktreeSession = options.runtimeConfig.worktree?.session;
  const mergeGate = worktreeSession ? new MergeGate(worktreeSession) : undefined;

  if (options.registerExtensions) {
    await options.registerExtensions(host);
  }

  // Core owns finalize; extension may also register /merge — prefer core gate via re-register.
  if (mergeGate) {
    host.registerCommand("merge", {
      description: "Show worktree diff and merge into the main tree after confirmation.",
      handler: async () => {
        const result = await mergeGate.promptMerge(ask, (message) => {
          output.write(`${message}\n`);
        });
        if ("skipped" in result) {
          return "merge skipped";
        }
        if (result.ok) {
          return result.summary;
        }
        return result.error;
      },
    });
  }

  await host.emit("session_start", {});

  const registration = host.getProvider(model.provider);
  if (!registration) {
    throw new Error(`provider not registered: ${model.provider}. Add it under [providers.*] in config.toml`);
  }
  const client = createLlmClient({
    registration,
    apiKey: resolveApiKey(registration, env),
  });

  return {
    host,
    model,
    async runPrompt(prompt: string) {
      const result = await runAgentLoop(prompt, {
        host,
        client,
        model: model.id,
        doneContract,
        verifyRepairTurns: verify.repairTurns,
        onAssistantText(text) {
          output.write(`\n${text}\n`);
        },
        onToolStart(call) {
          output.write(`\n→ ${call.name}(${JSON.stringify(call.arguments)})\n`);
        },
      });
      if (result.doneContract && !result.doneContract.passed) {
        output.write(`\n${result.doneContract.summary}\n`);
      }
      return { text: result.finalText, success: result.success };
    },
    async close() {
      await host.emit("session_end", {});
      if (mergeGate) {
        await mergeGate.finalizeSession(
          ask,
          { retainOnReject: options.runtimeConfig.worktree.retainOnReject },
          (message) => {
            output.write(`${message}\n`);
          },
        );
      }
    },
  };
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
  output.write("XioCode REPL — type a prompt, /help for commands, /exit to quit\n");
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
        output.write("Commands: /help /status /merge /sandbox /exit\nSlash commands map to registered extension commands when available.\n");
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
      try {
        await session.runPrompt(line);
      } catch (error) {
        output.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

function resolveDefaultModel(config: XioRuntimeConfig): ModelInfo {
  const provider = config.general.defaultProvider;
  const model = config.general.defaultModel;
  if (!provider || !model) {
    const first = Object.values(config.providers)[0];
    if (!first?.model) {
      throw new Error("no default provider/model configured");
    }
    return { provider: first.name, id: first.model, name: first.model, api: providerApi(first.kind) };
  }
  const configured = config.providers[provider];
  return {
    provider,
    id: model,
    name: model,
    api: configured ? providerApi(configured.kind) : "openai-completions",
  };
}

function registerConfiguredProviders(host: ExtensionHost, config: XioRuntimeConfig): void {
  for (const provider of Object.values(config.providers)) {
    if (!provider.model) {
      continue;
    }
    const registration: ProviderRegistration = {
      name: provider.name,
      api: providerApi(provider.kind),
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKeyEnv ? `$${provider.apiKeyEnv}` : undefined,
      authHeader: true,
      models: [
        {
          id: provider.model,
          name: provider.model,
          reasoning: provider.reasoning ?? false,
          thinkingLevelMap: provider.thinkingLevelMap,
          input: provider.input ? [...provider.input] : ["text"],
          contextWindow: provider.contextWindow ?? 128_000,
          maxTokens: provider.maxTokens ?? 8192,
          headers: provider.headers,
          compat: provider.compat,
        },
      ],
    };
    host.registerProvider(provider.name, registration);
  }
}

function providerApi(kind: string): string {
  if (kind === "anthropic") {
    return "anthropic-messages";
  }
  if (kind === "mistral") {
    return "mistral-conversations";
  }
  if (kind === "google") {
    return "google-generative-ai";
  }
  if (kind === "google-vertex") {
    return "google-vertex";
  }
  if (kind === "bedrock") {
    return "bedrock-converse-stream";
  }
  return "openai-completions";
}
