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

  it("maps product max/ultra to DeepSeek wire high|max per official docs", () => {
    const pro = { id: "deepseek-v4-pro", name: "deepseek-v4-pro" };
    // Official possible values: high | max
    // Compatibility: low/medium → high; xhigh → max
    expect(openAiReasoningEffort("minimal", pro)).toBe("high");
    expect(openAiReasoningEffort("low", pro)).toBe("high");
    expect(openAiReasoningEffort("medium", pro)).toBe("high");
    expect(openAiReasoningEffort("high", pro)).toBe("high");
    expect(openAiReasoningEffort("xhigh", pro)).toBe("max");
    expect(openAiReasoningEffort("max", pro)).toBe("max");
    // Client menus (Claude Code / Codex / XioCode) keep "ultra"; wire is still max
    expect(openAiReasoningEffort("ultra", pro)).toBe("max");
    // OpenAI-style: top wire tier is xhigh
    expect(openAiReasoningEffort("ultra", { id: "gpt-5", name: "gpt-5" })).toBe("xhigh");
    expect(openAiReasoningEffort("max", { id: "gpt-5", name: "gpt-5" })).toBe("xhigh");
    // Explicit map still wins
    expect(openAiReasoningEffort("ultra", {
      id: "deepseek-v4-pro",
      name: "deepseek-v4-pro",
      thinkingLevelMap: { ultra: "max" },
    })).toBe("max");
  });

  it("sets DeepSeek thinking toggle with effort levels", () => {
    const pro = { id: "deepseek-v4-pro", name: "deepseek-v4-pro" };
    expect(deepseekThinkingToggle("ultra", pro)).toEqual({ type: "enabled" });
    expect(deepseekThinkingToggle("max", pro)).toEqual({ type: "enabled" });
    expect(deepseekThinkingToggle("off", pro)).toEqual({ type: "disabled" });
    expect(deepseekThinkingToggle("high", { id: "gpt-5", name: "gpt-5" })).toBeUndefined();
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
