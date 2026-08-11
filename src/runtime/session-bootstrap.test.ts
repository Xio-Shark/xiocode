import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG_TOML } from "../cli/default-config.ts";
import { prepareSession, runSession } from "./session.ts";

import type { XioRuntimeConfig } from "../cli/config-parser.ts";
import type { InteractiveIO } from "./interactive-io.ts";
import type { ProjectTrustState } from "./project-trust.ts";
import type { LlmClient } from "./types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("prepareSession provider bootstrap", () => {
  it("prepares without a key and keeps /connect reachable after a failed prompt", async () => {
    const fixture = await createFixture();
    const statuses: string[] = [];
    const session = await prepareSession({
      cwd: fixture.root,
      workspaceRoot: fixture.root,
      runtimeConfig: runtimeConfig(fixture.root),
      env: fixture.env,
      projectTrust: trustedProject(fixture.root),
      uiSink: {
        setStatus: (key, text) => {
          if (key === "model" && text) statuses.push(text);
        },
      },
    });

    try {
      expect(session.host.getCommand("connect")).toBeDefined();
      expect(statuses.at(-1)).toBe("not connected · /connect");
      await expect(session.runPrompt("hello")).rejects.toThrow(/missing API key env: DEEPSEEK_API_KEY.*\/connect/is);
      expect(session.getHarnessPhase()).toBe("idle");
      expect(session.host.getCommand("connect")).toBeDefined();
    } finally {
      await session.close();
    }
  });

  it("keeps injected clients compatible without resolving an env key", async () => {
    const fixture = await createFixture();
    const statuses: string[] = [];
    const client: LlmClient = {
      async complete() {
        return { content: "injected-ok", toolCalls: [] };
      },
    };
    const session = await prepareSession({
      cwd: fixture.root,
      workspaceRoot: fixture.root,
      runtimeConfig: runtimeConfig(fixture.root),
      env: fixture.env,
      projectTrust: trustedProject(fixture.root),
      llmClient: client,
      uiSink: {
        setStatus: (key, text) => {
          if (key === "model" && text) statuses.push(text);
        },
      },
    });

    try {
      expect(statuses.at(-1)).toBe("deepseek/deepseek-chat");
      await expect(session.runPrompt("hello")).resolves.toMatchObject({
        success: true,
        text: "injected-ok",
      });
    } finally {
      await session.close();
    }
  });

  it("keeps prompt-once bootstrap non-interactive and fails at the model boundary", async () => {
    const fixture = await createFixture();
    await expect(runSession({
      cwd: fixture.root,
      workspaceRoot: fixture.root,
      runtimeConfig: runtimeConfig(fixture.root),
      env: fixture.env,
      projectTrust: trustedProject(fixture.root),
      promptOnce: "hello",
      uiSink: {},
    })).rejects.toThrow(/missing API key env: DEEPSEEK_API_KEY.*\/connect/is);
  });

  it("uses the client installed by /connect on the next prompt", async () => {
    const fixture = await createFixture();
    const statuses: string[] = [];
    const interactive = scriptedInteractive({
      selects: ["deepseek", "deepseek-chat"],
      prompts: ["sk-session-bootstrap-test"],
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/chat/completions")) {
        const body = [
          'data: {"choices":[{"delta":{"content":"connected-ok"}}]}',
          'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
          "data: [DONE]",
          "",
        ].join("\n\n");
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await prepareSession({
      cwd: fixture.root,
      workspaceRoot: fixture.root,
      runtimeConfig: runtimeConfig(fixture.root),
      env: fixture.env,
      projectTrust: trustedProject(fixture.root),
      interactive,
      uiSink: {
        setStatus: (key, text) => {
          if (key === "model" && text) statuses.push(text);
        },
      },
    });

    try {
      expect(statuses.at(-1)).toBe("not connected · /connect");
      await expect(session.host.runCommand("connect")).resolves.toContain(
        "connected deepseek/deepseek-chat",
      );
      expect(statuses.at(-1)).toBe("deepseek/deepseek-chat");

      await expect(session.runPrompt("hello")).resolves.toMatchObject({
        success: true,
        text: "connected-ok",
      });
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/chat/completions"))).toBe(true);

      const credentials = await readFile(path.join(fixture.xioHome, "credentials.json"), "utf8");
      expect(credentials).toContain("sk-session-bootstrap-test");
      const config = await readFile(fixture.configPath, "utf8");
      expect(config).not.toContain("sk-session-bootstrap-test");
    } finally {
      await session.close();
    }
  });
});

async function createFixture(): Promise<Readonly<{
  root: string;
  xioHome: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
}>> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-session-bootstrap-"));
  tempDirs.push(root);
  const xioHome = path.join(root, ".xiocode");
  const configPath = path.join(xioHome, "config.toml");
  await mkdir(xioHome, { recursive: true });
  await writeFile(configPath, DEFAULT_CONFIG_TOML, "utf8");
  return {
    root,
    xioHome,
    configPath,
    env: {
      HOME: root,
      XIO_HOME: xioHome,
      XIO_CONFIG: configPath,
    },
  };
}

function trustedProject(cwd: string): ProjectTrustState {
  return {
    cwd,
    normalizedPath: cwd,
    mode: "off",
    decision: "trusted",
    persisted: false,
  };
}

function scriptedInteractive(script: Readonly<{
  selects: Array<string | undefined>;
  prompts: Array<string | undefined>;
}>): InteractiveIO {
  const selects = [...script.selects];
  const prompts = [...script.prompts];
  return {
    ask: async () => true,
    select: async () => selects.shift(),
    prompt: async () => prompts.shift(),
  };
}

function runtimeConfig(runRoot: string): XioRuntimeConfig {
  return {
    general: {
      runRoot,
      maxTurns: 4,
      defaultProvider: "deepseek",
      defaultModel: "deepseek-chat",
    },
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
    verify: { enabled: false, requireAllPass: true, repairTurns: 0, commands: [] },
    agentsMd: { enabled: false, readClaudeDirs: false, maxBytes: 1, maxImportDepth: 1 },
    skills: { enabled: false, readClaude: false, readCursor: false, maxBodyBytes: 1 },
    hooks: { enabled: false, readClaude: false, timeoutMs: 1 },
    mcp: {
      enabled: false,
      readClaude: false,
      readCursor: false,
      failClosed: false,
      unknownSourceFailClosed: false,
      timeoutMs: 1,
      servers: {},
    },
    permissions: { allowHighRisk: false },
    explore: {
      enabled: false,
      maxTurns: 4,
      timeoutMs: 1_000,
      maxConcurrency: 1,
      maxOutputChars: 1_000,
      allowBash: false,
      maxTokens: 1_000,
      maxCostUsd: 1,
      maxStartsPerMinute: 1,
    },
    retrospective: {
      enabled: false,
      skipTrivial: true,
      minToolCalls: 1,
      autoInject: false,
      enqueueImprove: false,
      useLlm: false,
      sessionEndSubagent: false,
      sessionEndTimeoutMs: 1_000,
      normsAutoWrite: false,
    },
    regress: { offerOnFailure: false },
  };
}
