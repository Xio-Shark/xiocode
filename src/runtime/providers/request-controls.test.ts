import { describe, expect, it } from "vitest";

import {
  mapToolChoiceToWire,
  resolveRequestControls,
  shouldApplyToolChoice,
} from "./request-controls.ts";

import type { ProviderRegistration } from "../types.ts";

describe("request-controls", () => {
  it("maps OpenAI tool_choice values without inventing unsupported fields", () => {
    expect(mapToolChoiceToWire("openai-completions", "auto")).toEqual({
      kind: "openai",
      value: "auto",
    });
    expect(mapToolChoiceToWire("openai-completions", "required")).toEqual({
      kind: "openai",
      value: "required",
    });
    expect(mapToolChoiceToWire("openai-completions", "any")).toEqual({
      kind: "openai",
      value: "required",
    });
  });

  it("maps Anthropic tool_choice to official object shape", () => {
    expect(mapToolChoiceToWire("anthropic-messages", "auto")).toEqual({
      kind: "anthropic",
      value: { type: "auto" },
    });
    expect(mapToolChoiceToWire("anthropic-messages", "required")).toEqual({
      kind: "anthropic",
      value: { type: "any" },
    });
  });

  it("omits tool_choice for unsupported APIs", () => {
    expect(mapToolChoiceToWire("google-generative-ai", "required")).toEqual({
      kind: "omitted",
      reason: "unsupported_api:google-generative-ai",
    });
  });

  it("respects tool_choice_scope non_simple vs always", () => {
    const simple = [{ function: { parameters: { type: "object", properties: { path: { type: "string" } } } } }];
    const nested = [{
      function: {
        parameters: {
          type: "object",
          properties: { nested: { type: "object", properties: { a: { type: "string" } } } },
        },
      },
    }];
    expect(shouldApplyToolChoice("never", simple)).toBe(false);
    expect(shouldApplyToolChoice("always", simple)).toBe(true);
    expect(shouldApplyToolChoice("non_simple", simple)).toBe(false);
    expect(shouldApplyToolChoice("non_simple", nested)).toBe(true);
    expect(shouldApplyToolChoice("non_simple", [...simple, ...simple])).toBe(true);
  });

  it("resolves maxTokens from model registration when request omits it", () => {
    const registration: ProviderRegistration = {
      name: "deepseek",
      api: "openai-completions",
      toolChoice: "required",
      toolChoiceScope: "always",
      models: [{ id: "deepseek-chat", name: "deepseek-chat", maxTokens: 4096 }],
    };
    const resolved = resolveRequestControls({
      registration,
      modelId: "deepseek-chat",
      request: {
        tools: [{
          type: "function",
          function: { name: "read", description: "r", parameters: { type: "object", properties: {} } },
        }],
      },
    });
    expect(resolved.maxTokens).toBe(4096);
    expect(resolved.toolChoiceWire).toEqual({ kind: "openai", value: "required" });
  });
});
