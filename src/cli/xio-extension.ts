import { readFile } from "node:fs/promises";

import type { XioRuntimeConfig } from "./config-parser.ts";
import type { XioExtensionAPI } from "../runtime/index.ts";
import type { CommandHandlerContext, ExtensionContext } from "../../extensions/xio-evolve/src/types.ts";

export default async function registerXioRuntime(api: XioExtensionAPI): Promise<void> {
  const configPath = process.env.XIO_RUNTIME_CONFIG;
  const evolveApi = adaptEvolveApi(api);
  if (!configPath) {
    const [{ registerXioEvolve }, { registerXioSandbox }] = await Promise.all([loadEvolve(), loadSandbox()]);
    registerXioEvolve(evolveApi);
    registerXioSandbox(api);
    return;
  }

  const config = JSON.parse(await readFile(configPath, "utf8")) as XioRuntimeConfig;
  registerProviders(api, config);
  let currentRunId: string | undefined;
  const { registerXioEvolve, RunStore } = await loadEvolve();
  const runStore = new RunStore({ root: config.general.runRoot });

  if (config.extensions.evolve?.enabled !== false) {
    registerXioEvolve(evolveApi, {
      runStore,
      onRunStart(metadata) {
        currentRunId = metadata.run_id;
      },
    });
  }

  if (config.extensions.sandbox?.enabled !== false && config.worktree.enabled && config.worktree.session) {
    const { registerXioSandbox } = await loadSandbox();
    registerXioSandbox(api, {
      session: config.worktree.session,
      worktreeConfig: {
        enabled: config.worktree.enabled,
        retainOnReject: config.worktree.retainOnReject,
      },
    });
  }

  void currentRunId;
}

function adaptEvolveApi(api: XioExtensionAPI): ExtensionContext {
  return {
    on(event, handler) {
      api.on(event, (payload, ctx) => handler(payload, adaptEventContext(ctx, api)));
    },
    getActiveTools: () => api.getActiveTools(),
    getAllTools: () => api.getAllTools(),
    setActiveTools: (toolNames) => api.setActiveTools([...toolNames]),
    registerCommand(name, options) {
      api.registerCommand(name, {
        description: options.description,
        handler: async (args, ctx) => options.handler(args, adaptEventContext(ctx, api)),
      });
    },
  };
}

function adaptEventContext(ctx: unknown, api: XioExtensionAPI): CommandHandlerContext | undefined {
  const eventCtx = ctx as CommandHandlerContext & { hasUI?: boolean; ui?: CommandHandlerContext["ui"] } | undefined;
  if (!eventCtx) {
    return undefined;
  }
  try {
    const commandCtx: CommandHandlerContext = {
      model: eventCtx.model ?? api.model,
      modelRegistry: eventCtx.modelRegistry,
      setModel: (model) => api.setModel(model),
      getThinkingLevel: () => api.getThinkingLevel(),
      setThinkingLevel: (level) => api.setThinkingLevel(level),
      getSystemPrompt: eventCtx.getSystemPrompt,
    };
    return eventCtx.hasUI === false ? commandCtx : withLazyUi(commandCtx, eventCtx);
  } catch (error) {
    if (isStaleContextError(error)) {
      return undefined;
    }
    throw error;
  }
}

function withLazyUi(
  commandCtx: CommandHandlerContext,
  eventCtx: CommandHandlerContext & { ui?: CommandHandlerContext["ui"] },
): CommandHandlerContext {
  let ui: CommandHandlerContext["ui"] | undefined;
  return Object.defineProperty(commandCtx, "ui", {
    enumerable: true,
    get() {
      ui ??= safeUi(eventCtx);
      return ui;
    },
  }) as CommandHandlerContext;
}

function safeUi(eventCtx: CommandHandlerContext & { ui?: CommandHandlerContext["ui"] }): NonNullable<CommandHandlerContext["ui"]> {
  return {
    notify(message, level) {
      ignoreStaleContext(() => eventCtx.ui?.notify?.(message, level));
    },
    setStatus(key, text) {
      ignoreStaleContext(() => eventCtx.ui?.setStatus?.(key, text));
    },
    setWidget(key, content, options) {
      ignoreStaleContext(() => eventCtx.ui?.setWidget?.(key, content, options));
    },
  };
}

function ignoreStaleContext(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    if (!isStaleContextError(error)) {
      throw error;
    }
  }
}

function isStaleContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ctx is stale after session replacement or reload");
}

function registerProviders(api: XioExtensionAPI, config: XioRuntimeConfig): void {
  for (const provider of Object.values(config.providers)) {
    if (!provider.model) {
      continue;
    }
    api.registerProvider(provider.name, {
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
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: provider.contextWindow ?? 128_000,
          maxTokens: provider.maxTokens ?? 8192,
          headers: provider.headers,
          compat: provider.compat,
        },
      ],
    });
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

async function loadEvolve(): Promise<typeof import("../../extensions/xio-evolve/src/index.ts")> {
  return import("../../extensions/xio-evolve/src/index.ts");
}

async function loadSandbox(): Promise<typeof import("../../extensions/xio-sandbox/src/index.ts")> {
  return import("../../extensions/xio-sandbox/src/index.ts");
}
