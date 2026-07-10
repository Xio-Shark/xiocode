import { describe, expect, it } from "vitest";

import { createLlmClient } from "./client.ts";

import type { ProviderRegistration } from "../types.ts";

describe("provider usage normalization", () => {
  it("normalizes OpenAI-compatible usage once at the client boundary", async () => {
    const client = createLlmClient({
      registration: registration("openai-completions"),
      apiKey: "test",
      fetchImpl: async () => jsonResponse({
        choices: [{ message: { content: "done", tool_calls: [] } }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      }),
    });
    const response = await client.complete({ model: "test", messages: [] });
    expect(response.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheTokens: 40,
      reasoningTokens: 10,
    });
  });

  it("normalizes Anthropic cache usage and preserves unavailable reasoning as null", async () => {
    const client = createLlmClient({
      registration: registration("anthropic-messages"),
      apiKey: "test",
      fetchImpl: async () => jsonResponse({
        content: [{ type: "text", text: "done" }],
        usage: {
          input_tokens: 80,
          output_tokens: 20,
          cache_read_input_tokens: 25,
          cache_creation_input_tokens: 5,
        },
      }),
    });
    const response = await client.complete({ model: "test", messages: [] });
    expect(response.usage).toEqual({
      inputTokens: 110,
      outputTokens: 20,
      cacheTokens: 30,
      reasoningTokens: null,
    });
  });

  it("throws provider network failures instead of inventing a completion", async () => {
    const client = createLlmClient({
      registration: registration("openai-completions"),
      apiKey: "test",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(client.complete({ model: "test", messages: [] })).rejects.toThrow(/fetch failed/);
  });

  it("keeps unavailable usage fields null instead of estimating from characters", async () => {
    const client = createLlmClient({
      registration: registration("openai-completions"),
      apiKey: "test",
      fetchImpl: async () => jsonResponse({
        choices: [{ message: { content: "a".repeat(200), tool_calls: [] } }],
      }),
    });
    const response = await client.complete({ model: "test", messages: [] });
    expect(response.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheTokens: null,
      reasoningTokens: null,
    });
  });
});

function registration(api: string): ProviderRegistration {
  return {
    name: "test",
    api,
    baseUrl: "https://example.test",
    models: [{ id: "test", name: "test" }],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
