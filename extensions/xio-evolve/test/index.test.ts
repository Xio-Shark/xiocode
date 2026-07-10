import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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

    await registration.handlers.get("session_start")?.[0]?.({});
    expect(registration.setActiveToolsCalls).toEqual([]);
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
