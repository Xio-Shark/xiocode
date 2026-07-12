import { describe, expect, it } from "vitest";

import {
  availableThinkingLevels,
  cycleThinkingLevel,
  openAiReasoningEffort,
  anthropicThinkingConfig,
  parseThinkingLevel,
  THINKING_LEVELS,
} from "./thinking.ts";

describe("thinking helpers", () => {
  it("parses levels including ultra", () => {
    expect(parseThinkingLevel("ultra")).toBe("ultra");
    expect(parseThinkingLevel("nope")).toBeUndefined();
    expect(THINKING_LEVELS).toContain("ultra");
  });

  it("filters available levels from thinkingLevelMap keys", () => {
    expect(availableThinkingLevels({
      id: "m",
      name: "m",
      thinkingLevelMap: { low: "low", high: "large", ultra: "ultra" },
    })).toEqual(["low", "high", "ultra"]);
  });

  it("offers full ladder when reasoning is true without map", () => {
    expect(availableThinkingLevels({ id: "m", name: "m", reasoning: true })).toEqual([...THINKING_LEVELS]);
  });

  it("cycles through available levels", () => {
    expect(cycleThinkingLevel("high", ["low", "high", "ultra"])).toBe("ultra");
    expect(cycleThinkingLevel("ultra", ["low", "high", "ultra"])).toBe("low");
  });

  it("maps OpenAI reasoning_effort and omits off", () => {
    expect(openAiReasoningEffort("off", undefined)).toBeUndefined();
    expect(openAiReasoningEffort("high", undefined)).toBe("high");
    expect(openAiReasoningEffort("high", {
      id: "m",
      name: "m",
      thinkingLevelMap: { high: "large" },
    })).toBe("large");
  });

  it("maps Anthropic budget tokens", () => {
    expect(anthropicThinkingConfig("off", undefined)).toBeUndefined();
    expect(anthropicThinkingConfig("ultra", undefined)).toEqual({
      type: "enabled",
      budget_tokens: 128_000,
    });
    expect(anthropicThinkingConfig("high", {
      id: "m",
      name: "m",
      thinkingLevelMap: { high: "12000" },
    })).toEqual({ type: "enabled", budget_tokens: 12_000 });
    expect(anthropicThinkingConfig("high", undefined, "omitted")).toEqual({
      type: "enabled",
      budget_tokens: 16_384,
      display: "omitted",
    });
  });
});
