import { describe, expect, it } from "vitest";

import { ExtensionHost } from "../extension-host.ts";
import {
  createExploreTool,
  formatExploreResult,
  formatPrimaryExploreAddendum,
  PRIMARY_EXPLORE_PROMPT_ADDENDUM,
} from "./explore-tool.ts";
import { registerExploreCapability } from "./register.ts";
import { parseProviderModelRef, resolveExploreConfig } from "./resolve.ts";
import { suggestExploreConcurrency, tierForCount } from "./scale.ts";
import { Semaphore } from "./semaphore.ts";
import { formatExploreUserPrompt, withModelId } from "./subagent.ts";
import { MAX_EXPLORE_CONCURRENCY } from "./types.ts";

import type { XioRuntimeConfig } from "../../cli/config-parser.ts";
import type { LlmClient, ProviderRegistration } from "../types.ts";

describe("parseProviderModelRef", () => {
  it("splits provider/model and multi-segment model ids", () => {
    expect(parseProviderModelRef("opencode-go/deepseek-v4-flash")).toEqual({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
    });
    expect(parseProviderModelRef("openrouter/anthropic/claude-3")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-3",
    });
  });

  it("uses default provider for bare model ids", () => {
    expect(parseProviderModelRef("deepseek-v4-flash", "opencode-go")).toEqual({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
    });
  });
});

describe("resolveExploreConfig", () => {
  const base = {
    enabled: true,
    maxTurns: 12,
    timeoutMs: 180_000,
    maxConcurrency: 4,
    maxOutputChars: 16_000,
    allowBash: false,
  } as const;

  it("returns undefined when disabled", () => {
    expect(resolveExploreConfig(
      { ...base, enabled: false, model: "deepseek-v4-flash" },
      { runRoot: "~/.xiocode/runs", defaultProvider: "opencode-go" },
    )).toBeUndefined();
  });

  it("resolves bare model against default provider", () => {
    expect(resolveExploreConfig(
      { ...base, model: "deepseek-v4-flash" },
      { runRoot: "~/.xiocode/runs", defaultProvider: "opencode-go", defaultModel: "deepseek-v4-pro" },
    )).toMatchObject({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      maxConcurrency: 4,
    });
  });

  it("carries partition_hint", () => {
    expect(resolveExploreConfig(
      { ...base, model: "flash", partitionHint: "按功能模块拆" },
      { runRoot: "~/.xiocode/runs", defaultProvider: "opencode-go" },
    )).toMatchObject({ partitionHint: "按功能模块拆" });
  });

  it("honors explicit provider + model", () => {
    expect(resolveExploreConfig(
      { ...base, provider: "opencode-go", model: "deepseek-v4-flash" },
      { runRoot: "~/.xiocode/runs", defaultProvider: "deepseek" },
    )).toMatchObject({ provider: "opencode-go", model: "deepseek-v4-flash" });
  });
});

describe("Semaphore", () => {
  it("limits concurrent acquirers", async () => {
    const gate = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const run = async () => {
      const release = await gate.acquire();
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      release();
    };
    await Promise.all([run(), run(), run(), run()]);
    expect(peak).toBe(2);
  });
});

describe("formatExploreResult / prompts", () => {
  it("formats report metadata and truncates body", () => {
    const text = formatExploreResult({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      success: true,
      text: "x".repeat(50),
      turns: 3,
      toolCalls: 5,
      toolErrors: 0,
    }, 20);
    expect(text).toContain("model: opencode-go/deepseek-v4-flash");
    expect(text).toContain("…[truncated");
  });

  it("includes scope constraints and focus paths in user prompt", () => {
    const prompt = formatExploreUserPrompt("find auth", ["src/auth", "src/runtime"]);
    expect(prompt).toContain("Assigned goal");
    expect(prompt).toContain("find auth");
    expect(prompt).toContain("src/auth");
    expect(prompt).toContain("Read-only");
    expect(prompt).toContain("main agent");
    expect(prompt).toContain("verbatim");
    expect(prompt).toContain("absolute");
  });

  it("primary addendum encodes default~4, dynamic suggest, and partition hint", () => {
    const text = formatPrimaryExploreAddendum({
      maxConcurrency: 4,
      suggestedConcurrency: 2,
      scaleNote: "small (~80 source-like files)",
      partitionHint: "按接口划分",
    });
    expect(text).toContain("prefer about **2**");
    expect(text).toContain("Hard cap this session: 4");
    expect(text).toContain(String(MAX_EXPLORE_CONCURRENCY));
    expect(text).toContain("small");
    expect(text).toContain("按接口划分");
    expect(text).toContain("small (~80");
    expect(text).toMatch(/prefer `explore`|pure reading/i);
    expect(text).toMatch(/verbatim|absolute paths/i);
    expect(PRIMARY_EXPLORE_PROMPT_ADDENDUM).toContain("## Multi-explore");
  });
});

describe("suggestExploreConcurrency", () => {
  it("scales with tier and respects max_concurrency default 4", () => {
    expect(suggestExploreConcurrency({ tier: "tiny", fileCount: 10, capped: false }, 4)).toBe(1);
    expect(suggestExploreConcurrency({ tier: "small", fileCount: 80, capped: false }, 4)).toBe(2);
    expect(suggestExploreConcurrency({ tier: "medium", fileCount: 200, capped: false }, 4)).toBe(4);
    expect(suggestExploreConcurrency({ tier: "large", fileCount: 1000, capped: false }, 4)).toBe(4);
    expect(suggestExploreConcurrency({ tier: "huge", fileCount: 5000, capped: true }, 16)).toBe(12);
  });

  it("maps file counts to tiers", () => {
    expect(tierForCount(10, false)).toBe("tiny");
    expect(tierForCount(80, false)).toBe("small");
    expect(tierForCount(200, false)).toBe("medium");
    expect(tierForCount(1000, false)).toBe("large");
    expect(tierForCount(100, true)).toBe("huge");
  });
});

describe("withModelId", () => {
  it("appends missing model from template", () => {
    const reg: ProviderRegistration = {
      name: "opencode-go",
      api: "openai-completions",
      models: [{ id: "deepseek-v4-pro", name: "deepseek-v4-pro", reasoning: true, input: ["text"] }],
    };
    const next = withModelId(reg, "deepseek-v4-flash");
    expect(next.models.map((m) => m.id)).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(next.models[1]?.reasoning).toBe(true);
  });
});

describe("registerExploreCapability", () => {
  it("registers explore tool and prompt addendum when enabled", async () => {
    const host = new ExtensionHost({
      initialModel: { provider: "opencode-go", id: "deepseek-v4-pro" },
    });
    host.registerProvider("opencode-go", {
      name: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "$OPENCODE_API_KEY",
      models: [{ id: "deepseek-v4-pro", name: "deepseek-v4-pro", input: ["text"] }],
    });
    host.setSystemPrompt("You are XioCode.");

    const resolved = await registerExploreCapability(host, {
      runtimeConfig: runtimeWithExplore(true),
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
    });
    expect(resolved?.model).toBe("deepseek-v4-flash");
    expect(host.getTool("explore")).toBeDefined();
    expect(host.getProvider("opencode-go")?.models.some((m) => m.id === "deepseek-v4-flash")).toBe(true);

    const results = await host.emit("before_agent_start", { systemPrompt: "You are XioCode." });
    const last = results.at(-1) as { systemPrompt?: string } | undefined;
    expect(last?.systemPrompt).toContain("## Multi-explore");
    expect(last?.systemPrompt).toContain("Hard cap this session: 4");
    expect(last?.systemPrompt).toMatch(/prefer about \*\*\d+\*\*/);
    expect(last?.systemPrompt).toContain("You are XioCode.");
  });

  it("does nothing when explore is disabled", async () => {
    const host = new ExtensionHost();
    expect(await registerExploreCapability(host, {
      runtimeConfig: runtimeWithExplore(false),
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
    })).toBeUndefined();
    expect(host.getTool("explore")).toBeUndefined();
  });
});

describe("createExploreTool execute", () => {
  it("returns error when provider missing", async () => {
    const tool = createExploreTool({
      config: {
        provider: "missing",
        model: "flash",
        maxTurns: 4,
        timeoutMs: 5_000,
        maxConcurrency: 2,
        maxOutputChars: 8_000,
        allowBash: false,
      },
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => undefined,
    });
    const result = await tool.execute("1", { goal: "map auth" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("provider not registered");
  });

  it("runs a stub explore subagent via nested loop", async () => {
    const registration: ProviderRegistration = {
      name: "stub",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
      apiKey: "$STUB_KEY",
      models: [{ id: "flash", name: "flash", input: ["text"] }],
    };

    // Patch createLlmClient path by using a real subagent only if we mock fetch —
    // instead unit-test format path: call execute with resolveApiKey env and mock run via vi.
    // Here we only verify gate + missing key path is clear; integration uses stub client below.
    const tool = createExploreTool({
      config: {
        provider: "stub",
        model: "flash",
        maxTurns: 2,
        timeoutMs: 5_000,
        maxConcurrency: 1,
        maxOutputChars: 8_000,
        allowBash: false,
      },
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      getProvider: () => registration,
      env: {},
    });
    const result = await tool.execute("1", { goal: "where is agent loop" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/missing API key|explore error/i);
  });
});

describe("runExploreSubagent integration (stub client)", () => {
  it("completes with read-only tools and returns final text", async () => {
    const { runExploreSubagent } = await import("./subagent.ts");
    const stubClient: LlmClient = {
      async complete() {
        return { content: "Found agent-loop in src/runtime/agent-loop.ts", toolCalls: [] };
      },
    };
    const result = await runExploreSubagent({
      goal: "locate agent loop",
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      registration: {
        name: "stub",
        api: "openai-completions",
        models: [{ id: "flash", name: "flash", input: ["text"] }],
      },
      apiKey: "sk-test",
      modelId: "flash",
      maxTurns: 3,
      allowBash: false,
      createClient: () => stubClient,
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("agent-loop");
    expect(result.model).toBe("flash");
  });
});

function runtimeWithExplore(enabled: boolean): XioRuntimeConfig {
  return {
    general: {
      runRoot: "~/.xiocode/runs",
      defaultProvider: "opencode-go",
      defaultModel: "deepseek-v4-pro",
    },
    providers: {
      "opencode-go": {
        name: "opencode-go",
        kind: "openai",
        baseUrl: "https://opencode.ai/zen/go/v1",
        model: "deepseek-v4-pro",
        apiKeyEnv: "OPENCODE_API_KEY",
      },
    },
    worktree: { enabled: false, retainOnReject: false, allowDirty: false },
    extensions: {},
    verify: { enabled: false, requireAllPass: true, repairTurns: 3, commands: [] },
    agentsMd: { enabled: true, readClaudeDirs: true, maxBytes: 1, maxImportDepth: 1 },
    skills: { enabled: true, readClaude: true, readCursor: true, maxBodyBytes: 1 },
    hooks: { enabled: true, readClaude: true, timeoutMs: 1 },
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
      enabled,
      model: "deepseek-v4-flash",
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
