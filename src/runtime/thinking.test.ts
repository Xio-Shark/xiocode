import { describe, expect, it } from "vitest";

import {
  availableThinkingLevels,
  cycleThinkingLevel,
  deepseekThinkingToggle,
  openAiReasoningEffort,
  anthropicThinkingConfig,
  parseThinkingLevel,
  THINKING_LEVELS,
} from "./thinking.ts";

describe("thinking helpers", () => {
  it("offers the four-level product ladder", () => {
    expect([...THINKING_LEVELS]).toEqual(["off", "low", "high", "max"]);
  });

  it("parses levels and folds retired names onto the ladder", () => {
    expect(parseThinkingLevel("max")).toBe("max");
    expect(parseThinkingLevel(" HIGH ")).toBe("high");
    expect(parseThinkingLevel("minimal")).toBe("low");
    expect(parseThinkingLevel("medium")).toBe("high");
    expect(parseThinkingLevel("xhigh")).toBe("max");
    expect(parseThinkingLevel("ultra")).toBe("max");
    expect(parseThinkingLevel("nope")).toBeUndefined();
  });

  it("filters available levels from thinkingLevelMap keys", () => {
    expect(availableThinkingLevels({
      id: "m",
      name: "m",
      thinkingLevelMap: { low: "low", high: "large" },
    })).toEqual(["low", "high"]);
  });

  it("offers full ladder for every model without an explicit map", () => {
    expect(availableThinkingLevels({ id: "m", name: "m", reasoning: true })).toEqual([...THINKING_LEVELS]);
    expect(availableThinkingLevels({ id: "m", name: "m", reasoning: false })).toEqual([...THINKING_LEVELS]);
    expect(availableThinkingLevels({ id: "deepseek-v4-pro", name: "deepseek-v4-pro" })).toEqual([...THINKING_LEVELS]);
    expect(availableThinkingLevels(undefined)).toEqual([...THINKING_LEVELS]);
  });

  it("falls back to full ladder when map is empty", () => {
    expect(availableThinkingLevels({
      id: "m",
      name: "m",
      thinkingLevelMap: {},
    })).toEqual([...THINKING_LEVELS]);
  });

  it("cycles through available levels", () => {
    expect(cycleThinkingLevel("high", ["off", "low", "high", "max"])).toBe("max");
    expect(cycleThinkingLevel("max", ["off", "low", "high", "max"])).toBe("off");
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

  it("maps product levels to each gateway's wire enum", () => {
    const pro = { id: "deepseek-v4-pro", name: "deepseek-v4-pro" };
    // DeepSeek names low | high | max on the wire; off is the thinking toggle, not an effort.
    expect(openAiReasoningEffort("low", pro)).toBe("low");
    expect(openAiReasoningEffort("high", pro)).toBe("high");
    expect(openAiReasoningEffort("max", pro)).toBe("max");
    // OpenAI-style gateways stop at xhigh, so product max is their top tier.
    expect(openAiReasoningEffort("max", { id: "gpt-5", name: "gpt-5" })).toBe("xhigh");
    // Explicit map still wins.
    expect(openAiReasoningEffort("max", {
      id: "deepseek-v4-pro",
      name: "deepseek-v4-pro",
      thinkingLevelMap: { max: "high" },
    })).toBe("high");
  });

  it("sets DeepSeek thinking toggle with effort levels", () => {
    const pro = { id: "deepseek-v4-pro", name: "deepseek-v4-pro" };
    expect(deepseekThinkingToggle("max", pro)).toEqual({ type: "enabled" });
    expect(deepseekThinkingToggle("off", pro)).toEqual({ type: "disabled" });
    expect(deepseekThinkingToggle("high", { id: "gpt-5", name: "gpt-5" })).toBeUndefined();
  });

  it("maps Anthropic budget tokens", () => {
    expect(anthropicThinkingConfig("off", undefined)).toBeUndefined();
    expect(anthropicThinkingConfig("max", undefined)).toEqual({
      type: "enabled",
      budget_tokens: 65_536,
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
