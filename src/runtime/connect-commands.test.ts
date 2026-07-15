import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG_TOML } from "../cli/default-config.ts";
import { writeFile } from "node:fs/promises";
import { ExtensionHost } from "./extension-host.ts";
import { registerConnectCommands } from "./connect-commands.ts";
import { createPromptRunner } from "./session-lifecycle.ts";

import type { InteractiveIO } from "./interactive-io.ts";
import type { LlmClient, ModelInfo } from "./types.ts";
import type { XioRuntimeConfig } from "../cli/config-parser.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function fakeIo(script: {
  selects?: Array<string | undefined>;
  prompts?: Array<string | undefined>;
}): InteractiveIO & { secrets: string[] } {
  const selects = [...(script.selects ?? [])];
  const prompts = [...(script.prompts ?? [])];
  const secrets: string[] = [];
  return {
    secrets,
    ask: async () => true,
    select: async () => selects.shift(),
    prompt: async (_q, options) => {
      const value = prompts.shift();
      if (options?.secret && value) secrets.push(value);
      return value;
    },
  };
}

function baseRuntime(configPath: string): XioRuntimeConfig {
  void configPath;
  return {
    general: { runRoot: "~/.xiocode/runs", defaultProvider: "deepseek", defaultModel: "deepseek-chat" },
    providers: {
      deepseek: {
        name: "deepseek",
        kind: "openai",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
    },
    worktree: { enabled: false, retainOnReject: false, allowDirty: false },
    extensions: {},
    verify: { enabled: false, requireAllPass: true, repairTurns: 3, commands: [] },
    agentsMd: { enabled: true, readClaudeDirs: true, maxBytes: 1, maxImportDepth: 1 },
    skills: { enabled: true, readClaude: true, readCursor: true, maxBodyBytes: 1 },
    hooks: { enabled: true, readClaude: true, timeoutMs: 1 },
    mcp: { enabled: false, readClaude: false, readCursor: false, failClosed: false, unknownSourceFailClosed: false, timeoutMs: 1, servers: {} },
    permissions: { allowHighRisk: false },
    explore: {
      enabled: false,
      maxTurns: 12,
      timeoutMs: 180_000,
      maxConcurrency: 4,
      maxOutputChars: 16_000,
      allowBash: false,
    },
    retrospective: {
      enabled: true,
      skipTrivial: true,
      minToolCalls: 1,
      autoInject: true,
      enqueueImprove: true,
      useLlm: false,
    },
  };
}

describe("registerConnectCommands", () => {
  it("connects a provider, persists credentials outside toml, and switches model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "xio-connect-"));
    tempDirs.push(home);
    const configPath = path.join(home, "config.toml");
    await writeFile(configPath, DEFAULT_CONFIG_TOML, "utf8");
    const env: NodeJS.ProcessEnv = { XIO_HOME: home, XIO_CONFIG: configPath };
    const host = new ExtensionHost();
    host.registerProvider("deepseek", {
      name: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      apiKey: "$DEEPSEEK_API_KEY",
      models: [{ id: "deepseek-chat", name: "deepseek-chat", input: ["text"] }],
    });
    let current: ModelInfo = { provider: "deepseek", id: "deepseek-chat" };
    const notices: string[] = [];
    const io = fakeIo({
      selects: ["deepseek", "deepseek-chat"],
      prompts: ["sk-live-test-key-not-real"],
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
    }), { status: 200 }));

    registerConnectCommands({
      host,
      interactive: io,
      runtimeConfig: baseRuntime(configPath),
      env,
      sink: {
        notify: (message) => notices.push(message),
        setStatus: () => undefined,
      },
      getModel: () => current,
      setModel: async (model) => {
        current = model;
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const connected = await host.runCommand("connect");
    expect(connected).toContain("connected deepseek/deepseek-chat");
    expect(connected).not.toContain("sk-live-test-key-not-real");
    expect(env.DEEPSEEK_API_KEY).toBe("sk-live-test-key-not-real");
    expect(current).toEqual({
      provider: "deepseek",
      id: "deepseek-chat",
      name: "deepseek-chat",
      api: "openai-completions",
    });

    const toml = await readFile(configPath, "utf8");
    expect(toml).not.toContain("sk-live-test-key-not-real");
    expect(toml).toContain('api_key_env = "DEEPSEEK_API_KEY"');
    const creds = await readFile(path.join(home, "credentials.json"), "utf8");
    expect(creds).toContain("sk-live-test-key-not-real");
    expect(notices.join("\n")).not.toContain("sk-live-test-key-not-real");
    // Handler returns the user-facing summary; TUI/REPL prints it once (no duplicate sink.notify).
    expect(String(connected)).toMatch(/credentials/i);

    // /model with cached discovery
    const modelIo = fakeIo({
      selects: ["deepseek::deepseek-reasoner"],
    });
    registerConnectCommands({
      host,
      interactive: modelIo,
      runtimeConfig: baseRuntime(configPath),
      env,
      sink: { notify: () => undefined, setStatus: () => undefined },
      getModel: () => current,
      setModel: async (model) => {
        current = model;
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(host.runCommand("model")).resolves.toContain("model deepseek/deepseek-reasoner");
    expect(current.id).toBe("deepseek-reasoner");
  });

  it("tells the user to /connect when no providers have keys", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "xio-model-"));
    tempDirs.push(home);
    const configPath = path.join(home, "config.toml");
    await writeFile(configPath, DEFAULT_CONFIG_TOML, "utf8");
    const host = new ExtensionHost();
    registerConnectCommands({
      host,
      interactive: fakeIo({}),
      runtimeConfig: baseRuntime(configPath),
      env: { XIO_HOME: home, XIO_CONFIG: configPath },
      sink: {},
      getModel: () => ({ provider: "deepseek", id: "deepseek-chat" }),
      setModel: async () => {},
    });
    await expect(host.runCommand("model")).rejects.toThrow(/run \/connect first/i);
  });

  it("rejects invalid API keys from the probe", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "xio-badkey-"));
    tempDirs.push(home);
    const configPath = path.join(home, "config.toml");
    await writeFile(configPath, DEFAULT_CONFIG_TOML, "utf8");
    const host = new ExtensionHost();
    const fetchImpl = vi.fn(async () => new Response("unauthorized key=sk-echoed", { status: 401 }));
    registerConnectCommands({
      host,
      interactive: fakeIo({
        selects: ["openai"],
        prompts: ["bad-key"],
      }),
      runtimeConfig: baseRuntime(configPath),
      env: { XIO_HOME: home, XIO_CONFIG: configPath },
      sink: {},
      getModel: () => ({ provider: "deepseek", id: "deepseek-chat" }),
      setModel: async () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    try {
      await host.runCommand("connect");
      expect.fail("expected connect to reject");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/401|validation failed|auth/i);
      expect(message).not.toContain("sk-echoed");
      expect(message).not.toContain("bad-key");
    }
  });

  it("cancels without writing credentials when the user aborts provider select", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "xio-cancel-"));
    tempDirs.push(home);
    const configPath = path.join(home, "config.toml");
    await writeFile(configPath, DEFAULT_CONFIG_TOML, "utf8");
    const env: NodeJS.ProcessEnv = { XIO_HOME: home, XIO_CONFIG: configPath };
    const host = new ExtensionHost();
    registerConnectCommands({
      host,
      interactive: fakeIo({ selects: [undefined] }),
      runtimeConfig: baseRuntime(configPath),
      env,
      sink: {},
      getModel: () => ({ provider: "deepseek", id: "deepseek-chat" }),
      setModel: async () => {},
    });
    await expect(host.runCommand("connect")).resolves.toBe("connect cancelled");
    await expect(readFile(path.join(home, "credentials.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("createPromptRunner hot-switch", () => {
  it("reads the live model/client each turn", async () => {
    const host = new ExtensionHost();
    const modelsSeen: string[] = [];
    let model: ModelInfo = { provider: "a", id: "one" };
    let client: LlmClient = {
      async complete(request) {
        modelsSeen.push(model.id);
        void request;
        return { content: `ok-${model.id}`, toolCalls: [] };
      },
    };
    const runPrompt = createPromptRunner({
      host,
      getClient: () => client,
      getModel: () => model,
      getProviderApi: () => "openai-completions",
      verify: { enabled: false, requireAllPass: true, repairTurns: 3, commands: [] },
    });
    await runPrompt("first");
    model = { provider: "a", id: "two" };
    client = {
      async complete(request) {
        modelsSeen.push(model.id);
        void request;
        return { content: `ok-${model.id}`, toolCalls: [] };
      },
    };
    await runPrompt("second");
    expect(modelsSeen).toEqual(["one", "two"]);
  });
});
