import { describe, expect, it } from "vitest";

import { ExtensionHost } from "./extension-host.ts";
import { defineTool } from "./define-tool.ts";
import { Type } from "./schema.ts";
import { createBuiltinTools } from "./tools/builtin.ts";
import { runAgentLoop } from "./agent-loop.ts";

import type { LlmClient } from "./types.ts";

describe("ExtensionHost", () => {
  it("registers tools and emits lifecycle events", async () => {
    const host = new ExtensionHost();
    const seen: string[] = [];
    host.on("session_start", () => {
      seen.push("session_start");
    });
    host.registerTool(defineTool({
      name: "ping",
      description: "ping",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "pong" }] }),
    }));
    await host.emit("session_start", {});
    expect(seen).toEqual(["session_start"]);
    expect(host.getActiveTools()).toEqual(["ping"]);
  });
});

describe("createBuiltinTools", () => {
  it("exposes the six core tools", () => {
    const names = createBuiltinTools().map((tool) => tool.name);
    expect(names).toEqual(["read", "write", "edit", "bash", "grep", "glob"]);
  });
});

describe("runAgentLoop", () => {
  it("executes a tool call from a stub LLM client", async () => {
    const host = new ExtensionHost();
    const usageEvents: unknown[] = [];
    host.on("provider_response", (event) => {
      usageEvents.push(event);
    });
    for (const tool of createBuiltinTools({ cwd: process.cwd() })) {
      host.registerTool(tool);
    }
    let calls = 0;
    const client: LlmClient = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "bash", arguments: { command: "echo hi" } }],
            usage: { inputTokens: 10, outputTokens: 2, cacheTokens: 1, reasoningTokens: 0 },
          };
        }
        return {
          content: "done",
          toolCalls: [],
          usage: { inputTokens: 12, outputTokens: 3, cacheTokens: 0, reasoningTokens: 1 },
        };
      },
    };
    const result = await runAgentLoop("run echo", {
      host,
      client,
      model: "stub",
    });
    expect(result.finalText).toBe("done");
    expect(result.success).toBe(true);
    expect(result.turns).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.toolErrors).toBe(0);
    expect(result.usage).toEqual({
      inputTokens: 22,
      outputTokens: 5,
      cacheTokens: 1,
      reasoningTokens: 1,
    });
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toMatchObject({ providerApi: "unknown", model: "stub" });
    expect(result.messages.some((message) => message.role === "tool" && message.content.includes("hi"))).toBe(true);
  });
});
