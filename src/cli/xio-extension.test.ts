import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import registerXioRuntime from "./xio-extension.ts";

import type { XioExtensionAPI } from "../runtime/index.ts";

type Handler = (payload: unknown, ctx?: unknown) => unknown;

type Registration = Readonly<{
  handlers: Map<string, Handler[]>;
  commands: Map<string, { handler: (args: string, ctx?: unknown) => Promise<unknown> }>;
  providers: Map<string, unknown>;
  activeTools: string[];
  setActiveToolsCalls: string[][];
  selectedModels: unknown[];
  thinkingLevels: string[];
  api: XioExtensionAPI;
}>;

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.XIO_RUNTIME_CONFIG;
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("registerXioRuntime", () => {
  it("registers configured provider model capabilities", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-runtime-"));
    tempDirs.push(root);
    process.env.XIO_RUNTIME_CONFIG = path.join(root, "runtime-config.json");
    await writeFile(
      process.env.XIO_RUNTIME_CONFIG,
      JSON.stringify({
        general: { defaultProvider: "deepseek", defaultModel: "deepseek-chat", runRoot: path.join(root, "runs") },
        providers: {
          deepseek: {
            name: "deepseek",
            kind: "openai",
            baseUrl: "https://api.deepseek.com",
            model: "deepseek-chat",
            apiKeyEnv: "XIO_DEEPSEEK_KEY",
            reasoning: true,
            contextWindow: 64000,
            maxTokens: 4096,
            input: ["text", "image"],
            headers: { "X-Test": "enabled" },
            thinkingLevelMap: { high: "large" },
            compat: { thinkingFormat: "deepseek" },
          },
        },
        worktree: { enabled: true, retainOnReject: false, allowDirty: false },
        extensions: {
          evolve: { enabled: false, options: {} },
          sandbox: { enabled: false, options: {} },
        },
      }),
      "utf8",
    );
    const registration = createRegistration();

    await registerXioRuntime(registration.api);

    expect(registration.providers.get("deepseek")).toEqual(
      expect.objectContaining({
        name: "deepseek",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com",
        apiKey: "$XIO_DEEPSEEK_KEY",
        models: [
          expect.objectContaining({
            id: "deepseek-chat",
            reasoning: true,
            contextWindow: 64000,
            maxTokens: 4096,
            input: ["text", "image"],
            headers: { "X-Test": "enabled" },
            thinkingLevelMap: { high: "large" },
            compat: { thinkingFormat: "deepseek" },
          }),
        ],
      }),
    );
  });

  it("does not register provider-payload or model-switch hooks on the default evolve path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-runtime-"));
    tempDirs.push(root);
    process.env.XIO_RUNTIME_CONFIG = path.join(root, "runtime-config.json");
    await writeFile(
      process.env.XIO_RUNTIME_CONFIG,
      JSON.stringify({
        general: { defaultProvider: "deepseek", defaultModel: "chat", runRoot: path.join(root, "runs") },
        providers: {},
        worktree: { enabled: true, retainOnReject: false, allowDirty: false },
        extensions: {
          evolve: { enabled: true, options: { code_model: "openai/codex" } },
          sandbox: { enabled: false, options: {} },
        },
      }),
      "utf8",
    );
    const registration = createRegistration();

    await registerXioRuntime(registration.api);
    await registration.handlers.get("turn_start")?.[0]?.({ prompt: "implement tests" }, createEventContext());

    expect(registration.handlers.has("before_provider_request")).toBe(false);
    expect(registration.selectedModels).toEqual([]);
    expect(registration.thinkingLevels).toEqual([]);
  });

  it("returns command handler results through the runtime wrapper", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-runtime-"));
    tempDirs.push(root);
    process.env.XIO_RUNTIME_CONFIG = path.join(root, "runtime-config.json");
    await writeFile(
      process.env.XIO_RUNTIME_CONFIG,
      JSON.stringify({
        general: { defaultProvider: "deepseek", defaultModel: "chat", runRoot: path.join(root, "runs") },
        providers: {},
        worktree: { enabled: true, retainOnReject: false, allowDirty: false },
        extensions: {
          evolve: { enabled: true, options: {} },
          sandbox: { enabled: false, options: {} },
        },
      }),
      "utf8",
    );
    const registration = createRegistration();

    await registerXioRuntime(registration.api);
    const result = await registration.commands.get("status")?.handler("", createEventContext());

    expect(result).toEqual(expect.objectContaining({ provider: "unknown", model: "unknown" }));
  });

  it("does not mutate active tools on session start", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-runtime-"));
    tempDirs.push(root);
    process.env.XIO_RUNTIME_CONFIG = path.join(root, "runtime-config.json");
    await writeFile(
      process.env.XIO_RUNTIME_CONFIG,
      JSON.stringify({
        general: { defaultProvider: "deepseek", defaultModel: "chat", runRoot: path.join(root, "runs") },
        providers: {},
        worktree: { enabled: true, retainOnReject: false, allowDirty: false },
        extensions: {
          evolve: { enabled: true, options: {} },
          sandbox: { enabled: false, options: {} },
        },
      }),
      "utf8",
    );
    const registration = createRegistration({
      activeTools: ["read", "bash", "edit", "write"],
      allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    });

    await registerXioRuntime(registration.api);
    await registration.handlers.get("session_start")?.[0]?.({});

    expect(registration.setActiveToolsCalls).toEqual([]);
    expect(registration.activeTools).toEqual(["read", "bash", "edit", "write"]);
  });

  it("forwards fresh system prompts from event contexts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-runtime-"));
    tempDirs.push(root);
    process.env.XIO_RUNTIME_CONFIG = path.join(root, "runtime-config.json");
    await writeFile(
      process.env.XIO_RUNTIME_CONFIG,
      JSON.stringify({
        general: { defaultProvider: "deepseek", defaultModel: "chat", runRoot: path.join(root, "runs") },
        providers: {},
        worktree: { enabled: true, retainOnReject: false, allowDirty: false },
        extensions: {
          evolve: { enabled: true, options: {} },
          sandbox: { enabled: false, options: {} },
        },
        // Isolate TodoEnforcer prompt merge from hygiene addenda.
        agentsMd: { enabled: false },
        skills: { enabled: false },
        hooks: { enabled: false },
      }),
      "utf8",
    );
    const registration = createRegistration();

    await registerXioRuntime(registration.api);
    // Progressive emit across all before_agent_start handlers (ExtensionHost order).
    let systemPrompt = "";
    const eventCtx = createEventContext({ systemPrompt: "fresh base" });
    for (const handler of registration.handlers.get("before_agent_start") ?? []) {
      const result = await handler({ systemPrompt: "old base" }, {
        ...(eventCtx as object),
        getSystemPrompt: () => systemPrompt || "fresh base",
      });
      const next = (result as { systemPrompt?: string } | undefined)?.systemPrompt;
      if (typeof next === "string" && next.length > 0) {
        systemPrompt = next;
      }
    }

    expect(systemPrompt).toContain("fresh base");
    expect(systemPrompt).not.toContain("old base");
  });

  it("registers worktree sandbox status when session is present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-runtime-"));
    tempDirs.push(root);
    process.env.XIO_RUNTIME_CONFIG = path.join(root, "runtime-config.json");
    await writeFile(
      process.env.XIO_RUNTIME_CONFIG,
      JSON.stringify({
        general: { defaultProvider: "deepseek", defaultModel: "chat", runRoot: path.join(root, "runs") },
        providers: {},
        worktree: {
          enabled: true,
          retainOnReject: false,
          allowDirty: false,
          session: {
            mainRoot: root,
            worktreePath: root,
            branch: "xio/test",
            sessionId: "test",
            repoId: "repo",
            baseRef: "HEAD",
            baselineTree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
          },
        },
        extensions: {
          evolve: { enabled: false, options: {} },
          sandbox: { enabled: true, options: {} },
        },
        mcp: {
          enabled: false,
          readClaude: false,
          readCursor: false,
          failClosed: false,
          unknownSourceFailClosed: false,
          timeoutMs: 30_000,
          servers: {},
        },
        permissions: { allowHighRisk: false },
      }),
      "utf8",
    );
    const registration = createRegistration();
    const eventContext = createUiContext();

    await registerXioRuntime(registration.api);
    for (const handler of registration.handlers.get("session_start") ?? []) {
      await handler({}, eventContext);
    }
    expect(registration.commands.has("sandbox")).toBe(true);
  });

  it("does not read UI fields when adapted event contexts do not use UI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-runtime-"));
    tempDirs.push(root);
    process.env.XIO_RUNTIME_CONFIG = path.join(root, "runtime-config.json");
    await writeFile(
      process.env.XIO_RUNTIME_CONFIG,
      JSON.stringify({
        general: { defaultProvider: "deepseek", defaultModel: "chat", runRoot: path.join(root, "runs") },
        providers: {},
        worktree: { enabled: true, retainOnReject: false, allowDirty: false },
        extensions: {
          evolve: { enabled: true, options: {} },
          sandbox: { enabled: false, options: {} },
        },
      }),
      "utf8",
    );
    const registration = createRegistration();

    await registerXioRuntime(registration.api);
    await expect(registration.handlers.get("turn_start")?.[0]?.({ prompt: "hello" }, createStaleUiContext())).resolves.toBe("");
  });

  it("ignores stale UI errors when adapted UI methods are used", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-runtime-"));
    tempDirs.push(root);
    process.env.XIO_RUNTIME_CONFIG = path.join(root, "runtime-config.json");
    await writeFile(
      process.env.XIO_RUNTIME_CONFIG,
      JSON.stringify({
        general: { defaultProvider: "deepseek", defaultModel: "chat", runRoot: path.join(root, "runs") },
        providers: {},
        worktree: { enabled: true, retainOnReject: false, allowDirty: false },
        extensions: {
          evolve: { enabled: true, options: {} },
          sandbox: { enabled: false, options: {} },
        },
      }),
      "utf8",
    );
    const registration = createRegistration();

    await registerXioRuntime(registration.api);
    const result = await registration.commands.get("status")?.handler("", createStaleUiContext());

    expect(result).toEqual(expect.objectContaining({ provider: "unknown", model: "unknown" }));
  });
});

function createRegistration(options: {
  activeTools?: string[];
  allTools?: string[];
  currentModel?: { provider: string; id: string };
  currentThinkingLevel?: string;
  setModelRelease?: Promise<void>;
} = {}): Registration {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx?: unknown) => Promise<unknown> }>();
  const providers = new Map<string, unknown>();
  const activeTools = options.activeTools ?? [];
  const allTools = options.allTools ?? [];
  const setActiveToolsCalls: string[][] = [];
  const selectedModels: unknown[] = [];
  const thinkingLevels: string[] = [];
  let currentModel = options.currentModel;
  let currentThinkingLevel = options.currentThinkingLevel ?? "off";
  return {
    handlers,
    commands,
    providers,
    activeTools,
    setActiveToolsCalls,
    selectedModels,
    thinkingLevels,
    api: {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerCommand(name: string, command: { handler: (args: string, ctx?: unknown) => Promise<unknown> }) {
        commands.set(name, command);
      },
      registerTool() {},
      registerProvider(name: string, config: unknown) {
        providers.set(name, config);
      },
      getActiveTools() {
        return activeTools;
      },
      getAllTools() {
        return allTools.map((name) => ({ name }));
      },
      setActiveTools(toolNames: string[]) {
        setActiveToolsCalls.push([...toolNames]);
        activeTools.splice(0, activeTools.length, ...toolNames);
      },
      get model() {
        return currentModel;
      },
      setModel(model: unknown) {
        selectedModels.push(model);
        currentModel = model as { provider: string; id: string };
        return (options.setModelRelease ?? Promise.resolve()).then(() => true);
      },
      getThinkingLevel() {
        return currentThinkingLevel;
      },
      setThinkingLevel(level: string) {
        thinkingLevels.push(level);
        currentThinkingLevel = level;
      },
    } as unknown as XioExtensionAPI,
  };
}

function createEventContext(options: { systemPrompt?: string; model?: { provider: string; id: string; api?: string } } = {}): unknown {
  return {
    hasUI: false,
    model: options.model,
    modelRegistry: {
      find(provider: string, id: string) {
        return { provider, id };
      },
    },
    getSystemPrompt: options.systemPrompt === undefined ? undefined : () => options.systemPrompt,
  };
}

function createUiContext(): unknown {
  return {
    hasUI: true,
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
    },
  };
}

function createStaleUiContext(): unknown {
  return {
    hasUI: true,
    ui: {
      get notify() {
        throw new Error("ctx is stale after session replacement or reload");
      },
      get setStatus() {
        throw new Error("ctx is stale after session replacement or reload");
      },
      get setWidget() {
        throw new Error("ctx is stale after session replacement or reload");
      },
    },
  };
}
