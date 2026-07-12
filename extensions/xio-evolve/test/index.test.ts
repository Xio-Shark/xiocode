import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { registerXioEvolve, ResultDenoiser, RunStore } from "../src/index.ts";
import type { CommandHandlerContext, ExtensionContext, ToolInfo } from "../src/types.ts";

type Registration = {
  handlers: Map<string, Array<(payload: unknown, ctx?: CommandHandlerContext) => unknown>>;
  commands: Map<string, { description?: string; handler: (args?: unknown, ctx?: CommandHandlerContext) => unknown }>;
  api: ExtensionContext;
  setActiveToolsCalls: string[][];
};

function createRegistration(activeTools: string[] = ["read", "bash", "edit", "write"]): Registration {
  const handlers = new Map<string, Array<(payload: unknown, ctx?: CommandHandlerContext) => unknown>>();
  const commands = new Map<string, { description?: string; handler: (args?: unknown, ctx?: CommandHandlerContext) => unknown }>();
  const setActiveToolsCalls: string[][] = [];
  const api: ExtensionContext = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getActiveTools: () => activeTools,
    getAllTools: () => activeTools.map((name) => ({ name } satisfies ToolInfo)),
    setActiveTools(toolNames) {
      setActiveToolsCalls.push([...toolNames]);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
  };
  return { handlers, commands, api, setActiveToolsCalls };
}

describe("registerXioEvolve", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("registers recorder lifecycle and status without mutating active tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-index-"));
    tempDirs.push(root);
    const registration = createRegistration();
    registerXioEvolve(registration.api, { runStore: new RunStore({ root }) });

    expect(registration.commands.has("status")).toBe(true);
    expect(registration.commands.has("evolve")).toBe(false);
    expect(registration.handlers.has("session_start")).toBe(true);
    expect(registration.handlers.has("tool_call")).toBe(true);
    expect(registration.handlers.has("tool_result")).toBe(true);
    expect(registration.handlers.has("provider_response")).toBe(true);
    expect(registration.handlers.has("context_compaction")).toBe(true);

    await registration.handlers.get("session_start")?.[0]?.({});
    expect(registration.setActiveToolsCalls).toEqual([]);
  });

  it("records provider and model from session_start into metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-identity-"));
    tempDirs.push(root);
    const registration = createRegistration();
    const store = new RunStore({ root });
    registerXioEvolve(registration.api, { runStore: store });

    await registration.handlers.get("session_start")?.[0]?.({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
    });

    const record = (await store.listRecent(1))[0]!;
    expect(record.metadata.provider).toBe("opencode-go");
    expect(record.metadata.model).toBe("deepseek-v4-flash");
  });

  it("updates metadata when model_change fires", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-model-change-"));
    tempDirs.push(root);
    const registration = createRegistration();
    const store = new RunStore({ root });
    registerXioEvolve(registration.api, { runStore: store });

    await registration.handlers.get("session_start")?.[0]?.({ provider: "a", model: "m1" });
    await registration.handlers.get("model_change")?.[0]?.({ provider: "b", model: "m2" });

    const record = (await store.listRecent(1))[0]!;
    expect(record.metadata.provider).toBe("b");
    expect(record.metadata.model).toBe("m2");
  });

  it("keeps numeric usage fields in provider.usage events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-usage-events-"));
    tempDirs.push(root);
    const registration = createRegistration();
    const store = new RunStore({ root });
    registerXioEvolve(registration.api, { runStore: store });
    await registration.handlers.get("session_start")?.[0]?.({ provider: "openai", model: "gpt" });
    registration.handlers.get("provider_response")?.[0]?.({
      providerApi: "openai-completions",
      model: "gpt",
      usage: { inputTokens: 15, outputTokens: 4, cacheTokens: 3, reasoningTokens: 2 },
    });
    await registration.handlers.get("agent_end")?.[0]?.({});

    const record = (await store.listRecent(1))[0]!;
    const events = (await readFile(path.join(record.path, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; payload?: { usage?: Record<string, unknown> } });
    const usageEvent = events.find((event) => event.event === "provider.usage");
    expect(usageEvent?.payload?.usage).toEqual({
      inputTokens: 15,
      outputTokens: 4,
      cacheTokens: 3,
      reasoningTokens: 2,
    });
  });

  it("persists normalized provider usage in the existing run summary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-usage-"));
    tempDirs.push(root);
    const registration = createRegistration();
    const store = new RunStore({ root });
    registerXioEvolve(registration.api, { runStore: store });
    await registration.handlers.get("session_start")?.[0]?.({});
    registration.handlers.get("provider_response")?.[0]?.({
      providerApi: "openai-completions",
      model: "test",
      usage: { inputTokens: 15, outputTokens: 4, cacheTokens: 3, reasoningTokens: 2 },
    });
    await registration.handlers.get("agent_end")?.[0]?.({});
    const record = (await store.listRecent(1))[0]!;
    const summary = JSON.parse(await readFile(path.join(record.path, "summary.json"), "utf8")) as {
      usage: unknown;
    };
    expect(summary.usage).toEqual({
      inputTokens: 15,
      outputTokens: 4,
      cacheTokens: 3,
      reasoningTokens: 2,
    });
  });

  it("records successful context compaction usage in the run summary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-compact-usage-"));
    tempDirs.push(root);
    const registration = createRegistration();
    const store = new RunStore({ root });
    registerXioEvolve(registration.api, { runStore: store });
    await registration.handlers.get("session_start")?.[0]?.({});
    registration.handlers.get("context_compaction")?.[0]?.({
      stage: "success",
      mode: "manual",
      before: 40,
      after: 12,
      usage: { inputTokens: 9, outputTokens: 2, cacheTokens: 0, reasoningTokens: 0 },
    });
    await registration.handlers.get("agent_end")?.[0]?.({});

    const record = (await store.listRecent(1))[0]!;
    const summary = JSON.parse(await readFile(path.join(record.path, "summary.json"), "utf8")) as {
      usage: unknown;
    };
    expect(summary.usage).toEqual({
      inputTokens: 9,
      outputTokens: 2,
      cacheTokens: 0,
      reasoningTokens: 0,
    });
  });

  it("writes versioned provenance and prompt hashes for new runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-provenance-"));
    tempDirs.push(root);
    const registration = createRegistration();
    const store = new RunStore({ root });
    registerXioEvolve(registration.api, { runStore: store });
    await registration.handlers.get("session_start")?.[0]?.({
      provenance: {
        schema_version: "xio-run-provenance.v1",
        workspace_root: "/tmp/worktree",
        main_root: "/tmp/repo",
        base_commit: "abc123",
        branch: "main",
        dirty: false,
        dirty_summary_sha: "a".repeat(64),
        xiocode_revision: "1.1.0",
        created_at: "2026-07-11T00:00:00.000Z",
      },
    });
    const secret = `sk-${"a".repeat(48)}`;
    await registration.handlers.get("turn_start")?.[0]?.({ prompt: `private task ${secret}` });
    const record = (await store.listRecent(1))[0]!;
    const provenance = JSON.parse(await readFile(path.join(record.path, "provenance.json"), "utf8"));
    const prompt = JSON.parse(await readFile(path.join(record.path, "prompt.json"), "utf8"));
    expect(provenance.schema_version).toBe("xio-run-provenance.v1");
    expect(prompt).toMatchObject({ schema_version: "xio-run-prompt.v2" });
    expect(prompt.content).toContain("REDACTED");
    expect(prompt.content).not.toContain(secret);
    expect(prompt.prompt_sha).toBe(createHash("sha256").update(prompt.content).digest("hex"));
  });

  it("rejects malformed provenance but accepts legacy empty session payloads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-provenance-"));
    tempDirs.push(root);
    const registration = createRegistration();
    registerXioEvolve(registration.api, { runStore: new RunStore({ root }) });
    await expect(registration.handlers.get("session_start")?.[0]?.({
      provenance: { schema_version: "xio-run-provenance.v2" },
    })).rejects.toThrow("unsupported schema");

    const legacy = createRegistration();
    registerXioEvolve(legacy.api, { runStore: new RunStore({ root: path.join(root, "legacy") }) });
    await expect(legacy.handlers.get("session_start")?.[0]?.({})).resolves.toBeDefined();
  });

  it("appends todo addendum on before_agent_start", async () => {
    const registration = createRegistration();
    registerXioEvolve(registration.api, { runStore: new RunStore({ root: "/tmp/xio-index-test" }) });
    const result = await registration.handlers.get("before_agent_start")?.[0]?.(
      { systemPrompt: "base" },
      { getSystemPrompt: () => "base" },
    );
    const systemPrompt = (result as { systemPrompt?: string })?.systemPrompt ?? "";
    expect(systemPrompt).toContain("base");
    expect(systemPrompt).toContain("XioCode TODO Protocol");
    expect(systemPrompt).not.toContain("search_context");
  });

  it("denoises tool results on the default path", async () => {
    const registration = createRegistration();
    const denoiser = new ResultDenoiser({ maxReadLines: 2, enableOutlineGeneration: false });
    registerXioEvolve(registration.api, {
      runStore: new RunStore({ root: "/tmp/xio-index-test" }),
      resultDenoiser: denoiser,
    });
    await registration.handlers.get("session_start")?.[0]?.({});
    await registration.handlers.get("tool_call")?.[0]?.({ toolName: "read", toolCallId: "1", input: { file_path: "a.ts" } });
    const result = await registration.handlers.get("tool_result")?.[0]?.({
      toolName: "read",
      toolCallId: "1",
      content: "line1\nline2\nline3\nline4",
      input: { file_path: "a.ts" },
    });
    const raw = result && typeof result === "object" && "content" in result
      ? (result as { content: unknown }).content
      : "";
    const content = typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw.map((block) => (typeof block === "object" && block && "text" in block ? String((block as { text: unknown }).text) : "")).join("\n")
        : String(raw);
    expect(content).toContain("line1");
    expect(content).not.toContain("line4");
  });

  it("status command returns run metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-status-"));
    tempDirs.push(root);
    const registration = createRegistration();
    registerXioEvolve(registration.api, { runStore: new RunStore({ root }) });
    await registration.handlers.get("session_start")?.[0]?.({});
    const status = await registration.commands.get("status")?.handler({}, {
      model: { provider: "deepseek", id: "chat" },
      ui: { notify() {}, setWidget() {}, setStatus() {} },
    });
    expect(status).toMatchObject({ provider: "deepseek", model: "chat" });
    expect((status as { runId: string }).runId).not.toBe("none");
  });
});
