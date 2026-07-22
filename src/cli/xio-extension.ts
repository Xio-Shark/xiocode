import { readFile } from "node:fs/promises";
import os from "node:os";

import type { XioMcpConfig, XioRuntimeConfig } from "./config-parser.ts";
import type { XioExtensionAPI } from "../runtime/index.ts";
import type { CommandHandlerContext, ExtensionContext } from "../../extensions/xio-evolve/src/types.ts";
import { parseServerSpec, type McpConfig, type McpServerSpec } from "../../extensions/xio-hygiene/src/mcp.ts";

/**
 * Load runtime config from XIO_RUNTIME_CONFIG (or minimal defaults) and register extensions.
 * CLI interactive path continues to use this entry.
 */
export default async function registerXioRuntime(api: XioExtensionAPI): Promise<void> {
  const configPath = process.env.XIO_RUNTIME_CONFIG;
  if (!configPath) {
    await registerRuntimeFromConfig(api, {
      general: { runRoot: pathJoinHome(".xiocode", "runs") },
      providers: {},
      worktree: { enabled: false, retainOnReject: false, allowDirty: false },
      extensions: {},
    } as XioRuntimeConfig, {
      workspaceCwd: process.env.XIO_MAIN_ROOT ?? process.cwd(),
      home: os.homedir(),
      minimal: true,
    });
    return;
  }

  const config = JSON.parse(await readFile(configPath, "utf8")) as XioRuntimeConfig;
  await registerRuntimeFromConfig(api, config, {
    workspaceCwd: config.worktree.session?.worktreePath
      ?? process.env.XIO_WORKTREE
      ?? process.env.XIO_MAIN_ROOT
      ?? process.cwd(),
    home: os.homedir(),
  });
}

/**
 * Config-bound extension registration (hygiene / evolve / MCP / optional sandbox).
 * Used by interactive CLI (via file) and self-improve agent (in-memory, no worktree session).
 */
export async function registerRuntimeFromConfig(
  api: XioExtensionAPI,
  config: XioRuntimeConfig,
  options: Readonly<{
    workspaceCwd: string;
    home?: string;
    configRoot?: string;
    /** When true, skip provider registration and use default hygiene only (no config file). */
    minimal?: boolean;
    /**
     * When false, skip project-local hooks/skills/AGENTS/MCP.
     * Defaults from XIO_INCLUDE_PROJECT env ("0" → false) or true.
     */
    includeProject?: boolean;
  }>,
): Promise<void> {
  const evolveApi = adaptEvolveApi(api);
  const home = options.home ?? os.homedir();
  const workspaceCwd = options.workspaceCwd;
  const includeProject = options.includeProject
    ?? process.env.XIO_INCLUDE_PROJECT !== "0";

  if (options.minimal) {
    const [{ registerXioHygiene }, { registerXioEvolve }, { registerXioSandbox }] = await Promise.all([
      loadHygiene(),
      loadEvolve(),
      loadSandbox(),
    ]);
    registerXioHygiene(evolveApi, {
      cwd: workspaceCwd,
      home,
      includeProject,
      registerTool: (tool) => api.registerTool(tool),
      warn: (message) => console.warn(message),
    });
    registerXioEvolve(evolveApi);
    registerXioSandbox(api);
    return;
  }

  registerProviders(api, config);
  const [{ registerXioHygiene }, { registerXioEvolve, RunStore }] = await Promise.all([loadHygiene(), loadEvolve()]);
  const runStore = new RunStore({ root: config.general.runRoot });

  registerXioHygiene(evolveApi, {
    cwd: workspaceCwd,
    home,
    includeProject,
    agentsMd: config.agentsMd ?? {
      enabled: true,
      readClaudeDirs: true,
      maxBytes: 65_536,
      maxImportDepth: 3,
    },
    skills: config.skills ?? {
      enabled: true,
      readClaude: true,
      readCursor: true,
      maxBodyBytes: 32_768,
    },
    hooks: config.hooks ?? {
      enabled: true,
      readClaude: true,
      timeoutMs: 5_000,
    },
    mcp: toHygieneMcp(config.mcp),
    registerTool: (tool) => api.registerTool(tool),
    warn: (message) => console.warn(message),
  });

  if (config.extensions.evolve?.enabled !== false) {
    registerXioEvolve(evolveApi, {
      runStore,
      retrospective: {
        ...config.retrospective,
        getWorkspaceRoot: () => workspaceCwd,
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
        allowDirty: config.worktree.allowDirty,
      },
    });
  }
}

function pathJoinHome(...parts: string[]): string {
  return [os.homedir(), ...parts].join("/");
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
    getRuntimeEvents: () => api.getRuntimeEvents?.(),
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
      thinkingDisplay: provider.thinkingDisplay,
      toolChoice: provider.toolChoice,
      toolChoiceScope: provider.toolChoiceScope,
      models: [
        {
          id: provider.model,
          name: provider.model,
          // Default true so effort UI works without per-provider flags; set reasoning = false to document non-reasoning models.
          reasoning: provider.reasoning ?? true,
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

async function loadHygiene(): Promise<typeof import("../../extensions/xio-hygiene/src/index.ts")> {
  return import("../../extensions/xio-hygiene/src/index.ts");
}

async function loadEvolve(): Promise<typeof import("../../extensions/xio-evolve/src/index.ts")> {
  return import("../../extensions/xio-evolve/src/index.ts");
}

async function loadSandbox(): Promise<typeof import("../../extensions/xio-sandbox/src/index.ts")> {
  return import("../../extensions/xio-sandbox/src/index.ts");
}

function toHygieneMcp(mcp: XioMcpConfig | undefined): Partial<McpConfig> {
  if (!mcp) {
    return {
      enabled: true,
      readClaude: true,
      readCursor: true,
      failClosed: false,
      unknownSourceFailClosed: false,
      timeoutMs: 30_000,
    };
  }
  const servers: Record<string, McpServerSpec> = {};
  const warnings: string[] = [];
  for (const [name, entry] of Object.entries(mcp.servers)) {
    const spec = parseServerSpec(name, entry, warnings);
    if (spec) {
      servers[name] = spec;
    }
  }
  for (const warning of warnings) {
    console.warn(warning);
  }
  return {
    enabled: mcp.enabled,
    readClaude: mcp.readClaude,
    readCursor: mcp.readCursor,
    failClosed: mcp.failClosed,
    unknownSourceFailClosed: mcp.unknownSourceFailClosed,
    timeoutMs: mcp.timeoutMs,
    servers: Object.keys(servers).length > 0 ? servers : undefined,
  };
}
