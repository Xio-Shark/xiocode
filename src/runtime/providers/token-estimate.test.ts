import { describe, expect, it } from "vitest";

import {
  estimateMessagesTokens,
  estimateTextTokens,
  resolveSessionTokenBudget,
} from "./token-estimate.ts";

describe("token-estimate", () => {
  it("estimates text tokens approximately", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("a".repeat(8))).toBe(2);
  });

  it("counts tool call arguments in message estimates", () => {
    const tokens = estimateMessagesTokens([
      { role: "assistant", content: "hi", toolCalls: [{ id: "1", name: "read", arguments: { path: "a.ts" } }] },
      { role: "tool", content: "body", toolCallId: "1", name: "read" },
    ]);
    expect(tokens).toBeGreaterThan(10);
  });

  it("resolves session token budget from config or context window", () => {
    expect(resolveSessionTokenBudget({ configured: 4096 })).toBe(4096);
    expect(resolveSessionTokenBudget({ contextWindow: 100_000 })).toBe(75_000);
    expect(resolveSessionTokenBudget({})).toBeUndefined();
    expect(() => resolveSessionTokenBudget({ configured: 100 })).toThrow(/max_session_tokens/);
  });
});
