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
          };
        }
        return { content: "done", toolCalls: [] };
      },
    };
    const result = await runAgentLoop("run echo", {
      host,
      client,
      model: "stub",
    });
    expect(result.finalText).toBe("done");
    expect(result.success).toBe(true);
    expect(result.messages.some((message) => message.role === "tool" && message.content.includes("hi"))).toBe(true);
  });
});
