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

  it("parses OpenAI SSE deltas through completeStream", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const client = createLlmClient({
      registration: registration("openai-completions"),
      apiKey: "test",
      fetchImpl: async () => streamResponse(sse),
    });
    expect(client.completeStream).toBeTypeOf("function");
    const events = [];
    for await (const event of client.completeStream!({ model: "test", messages: [] })) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === "text_delta").map((event) =>
      event.type === "text_delta" ? event.text : ""
    )).toEqual(["Hel", "lo"]);
    const done = events.find((event) => event.type === "done");
    expect(done).toMatchObject({ type: "done", content: "Hello" });
  });

  it("aborts an in-flight OpenAI complete when the signal fires", async () => {
    const controller = new AbortController();
    const client = createLlmClient({
      registration: registration("openai-completions"),
      apiKey: "test",
      fetchImpl: async (_url, init) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted.", "AbortError"));
          }, { once: true });
        });
        return jsonResponse({ choices: [{ message: { content: "late", tool_calls: [] } }] });
      },
    });
    const pending = client.complete({ model: "test", messages: [] }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("parses Anthropic SSE text deltas through completeStream", async () => {
    const sse = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":4,"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const client = createLlmClient({
      registration: registration("anthropic-messages"),
      apiKey: "test",
      fetchImpl: async () => streamResponse(sse),
    });
    const events = [];
    for await (const event of client.completeStream!({ model: "test", messages: [] })) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === "text_delta").map((event) =>
      event.type === "text_delta" ? event.text : ""
    )).toEqual(["Hi", "!"]);
    const done = events.find((event) => event.type === "done");
    expect(done).toMatchObject({ type: "done", content: "Hi!" });
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

function streamResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
