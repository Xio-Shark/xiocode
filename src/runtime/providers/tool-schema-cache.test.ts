import { describe, expect, it, beforeEach } from "vitest";

import { getCachedProviderTools, resetToolSchemaCacheForTests } from "./tool-schema-cache.ts";

import type { ToolDefinition } from "../types.ts";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `desc-${name}`,
    parameters: { type: "object", properties: { x: { type: "string" } } },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

describe("tool-schema-cache", () => {
  beforeEach(() => {
    resetToolSchemaCacheForTests();
  });

  it("sorts tools deterministically and caches by tool set", () => {
    const first = getCachedProviderTools("openai-completions", [tool("write"), tool("read")]);
    expect(first.cache).toBe("miss");
    expect(first.tools.map((entry) => entry.function.name)).toEqual(["read", "write"]);

    const second = getCachedProviderTools("openai-completions", [tool("read"), tool("write")]);
    expect(second.cache).toBe("hit");
    expect(second.key).toBe(first.key);
    expect(second.tools).toBe(first.tools);
  });

  it("misses when the active tool set changes", () => {
    const a = getCachedProviderTools("openai-completions", [tool("read")]);
    const b = getCachedProviderTools("openai-completions", [tool("read"), tool("bash")]);
    expect(a.cache).toBe("miss");
    expect(b.cache).toBe("miss");
    expect(a.key).not.toBe(b.key);
  });
});
