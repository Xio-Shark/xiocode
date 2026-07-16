import { describe, expect, it } from "vitest";

import { createLlmClient } from "./client.ts";

import type { ProviderRegistration } from "../types.ts";

describe("provider usage normalization", () => {
  it("omits HTTP response bodies from LLM failure messages", async () => {
    const client = createLlmClient({
      registration: registration("openai-completions"),
      apiKey: "sk-live-secret",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "bad key sk-live-secret" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(client.complete({ model: "test", messages: [] })).rejects.toThrow(
      /^LLM request failed \(401\)$/,
    );
  });

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
  it("parses Anthropic thinking_delta events without mixing into content", async () => {
    const sse = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}\n\n',
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
    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", text: "plan" },
    ]);
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "answer" },
    ]);
    const done = events.find((event) => event.type === "done");
    expect(done).toMatchObject({ type: "done", content: "answer" });
  });

  it("parses OpenAI reasoning_content as thinking_delta", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"why"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const client = createLlmClient({
      registration: registration("openai-completions"),
      apiKey: "test",
      fetchImpl: async () => streamResponse(sse),
    });
    const events = [];
    for await (const event of client.completeStream!({ model: "test", messages: [] })) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", text: "why" },
    ]);
  });

  it("suppresses thinking_delta text when thinkingDisplay is omitted", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"secret"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"visible"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const client = createLlmClient({
      registration: { ...registration("openai-completions"), thinkingDisplay: "omitted" },
      apiKey: "test",
      fetchImpl: async () => streamResponse(sse),
    });
    const events = [];
    for await (const event of client.completeStream!({ model: "test", messages: [] })) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([]);
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "visible" },
    ]);
  });

  it("passes Anthropic thinking display on the wire when configured", async () => {
    let body: Record<string, unknown> | undefined;
    const client = createLlmClient({
      registration: { ...registration("anthropic-messages"), thinkingDisplay: "omitted" },
      apiKey: "test",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
      },
    });
    await client.complete({ model: "test", messages: [{ role: "user", content: "hi" }], thinkingLevel: "high" });
    expect(body?.thinking).toEqual({ type: "enabled", budget_tokens: 16_384, display: "omitted" });
  });

  it("injects reasoning_effort for non-off thinking levels", async () => {
    let body: Record<string, unknown> | undefined;
    const client = createLlmClient({
      registration: {
        name: "test",
        api: "openai-completions",
        baseUrl: "https://example.test",
        models: [{
          id: "test",
          name: "test",
          reasoning: true,
          thinkingLevelMap: { high: "large", ultra: "ultra" },
        }],
      },
      apiKey: "test",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ choices: [{ message: { content: "ok", tool_calls: [] } }] });
      },
    });
    await client.complete({ model: "test", messages: [], thinkingLevel: "high" });
    expect(body?.reasoning_effort).toBe("large");
    await client.complete({ model: "test", messages: [], thinkingLevel: "off" });
    expect(body?.reasoning_effort).toBeUndefined();
  });

  it("wires deepseek ultra/max as max + thinking enabled (official V4 shape)", async () => {
    let body: Record<string, unknown> | undefined;
    const client = createLlmClient({
      registration: {
        name: "opencode-go",
        api: "openai-completions",
        baseUrl: "https://opencode.ai/zen/go/v1",
        models: [{ id: "deepseek-v4-pro", name: "deepseek-v4-pro", reasoning: true }],
      },
      apiKey: "test",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ choices: [{ message: { content: "ok", tool_calls: [] } }] });
      },
    });
    await client.complete({
      model: "deepseek-v4-pro",
      messages: [],
      thinkingLevel: "ultra",
    });
    expect(body?.reasoning_effort).toBe("max");
    expect(body?.thinking).toEqual({ type: "enabled" });
    await client.complete({
      model: "deepseek-v4-pro",
      messages: [],
      thinkingLevel: "max",
    });
    expect(body?.reasoning_effort).toBe("max");
    expect(body?.thinking).toEqual({ type: "enabled" });
    await client.complete({
      model: "deepseek-v4-pro",
      messages: [],
      thinkingLevel: "off",
    });
    expect(body?.reasoning_effort).toBeUndefined();
    expect(body?.thinking).toEqual({ type: "disabled" });
  });

  it("injects Anthropic thinking budget for non-off levels", async () => {
    let body: Record<string, unknown> | undefined;
    const client = createLlmClient({
      registration: registration("anthropic-messages"),
      apiKey: "test",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
      },
    });
    await client.complete({ model: "test", messages: [{ role: "user", content: "hi" }], thinkingLevel: "ultra" });
    expect(body?.thinking).toEqual({ type: "enabled", budget_tokens: 128_000 });
  });

  it("wires configured max_tokens and tool_choice on OpenAI-compatible payloads", async () => {
    let body: Record<string, unknown> | undefined;
    const client = createLlmClient({
      registration: {
        name: "test",
        api: "openai-completions",
        baseUrl: "https://example.test",
        toolChoice: "required",
        toolChoiceScope: "always",
        models: [{ id: "test", name: "test", maxTokens: 2048 }],
      },
      apiKey: "test",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ choices: [{ message: { content: "ok", tool_calls: [] } }] });
      },
    });
    await client.complete({
      model: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        type: "function",
        function: { name: "read", description: "r", parameters: { type: "object", properties: {} } },
      }],
      maxTokens: 1024,
      toolChoice: "required",
      toolChoiceScope: "always",
    });
    expect(body?.max_tokens).toBe(1024);
    expect(body?.tool_choice).toBe("required");
  });

  it("wires Anthropic tool_choice and cache_control on system/tools", async () => {
    let body: Record<string, unknown> | undefined;
    const client = createLlmClient({
      registration: {
        ...registration("anthropic-messages"),
        toolChoice: "any",
        toolChoiceScope: "always",
        models: [{ id: "test", name: "test", maxTokens: 4096 }],
      },
      apiKey: "test",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
      },
    });
    await client.complete({
      model: "test",
      messages: [
        { role: "system", content: "stable system" },
        { role: "user", content: "hi" },
      ],
      tools: [{
        type: "function",
        function: { name: "read", description: "r", parameters: { type: "object", properties: {} } },
      }],
      toolChoice: "any",
      toolChoiceScope: "always",
      promptCache: true,
    });
    expect(body?.max_tokens).toBe(4096);
    expect(body?.tool_choice).toEqual({ type: "any" });
    expect(Array.isArray(body?.system)).toBe(true);
    const systemBlocks = body?.system as Array<Record<string, unknown>>;
    expect(systemBlocks.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    const tools = body?.tools as Array<Record<string, unknown>>;
    expect(tools.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("places Anthropic cache_control on last stable system block, not dynamic inject", async () => {
    let body: Record<string, unknown> | undefined;
    const client = createLlmClient({
      registration: {
        ...registration("anthropic-messages"),
        models: [{ id: "test", name: "test", maxTokens: 4096 }],
      },
      apiKey: "test",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
      },
    });
    await client.complete({
      model: "test",
      messages: [
        { role: "system", content: "canonical stable system" },
        { role: "system", content: "project rules addenda" },
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
        { role: "system", content: "git: main\nstatus: dirty" },
        { role: "user", content: "second" },
      ],
      promptCache: true,
    });
    const systemBlocks = body?.system as Array<Record<string, unknown>>;
    expect(systemBlocks.map((block) => block.text)).toEqual([
      "canonical stable system",
      "project rules addenda",
      "git: main\nstatus: dirty",
    ]);
    expect(systemBlocks[0]?.cache_control).toBeUndefined();
    expect(systemBlocks[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(systemBlocks[2]?.cache_control).toBeUndefined();
    const wireMessages = body?.messages as Array<Record<string, unknown>>;
    expect(wireMessages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  });

  it("does not invent tool_choice for unsupported provider APIs", async () => {
    // openai client is used for non-anthropic; google is still openai-compatible path only when
    // createLlmClient routes there. Unsupported map is covered in request-controls; here ensure
    // omitting toolChoice leaves wire without tool_choice.
    let body: Record<string, unknown> | undefined;
    const client = createLlmClient({
      registration: registration("openai-completions"),
      apiKey: "test",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ choices: [{ message: { content: "ok", tool_calls: [] } }] });
      },
    });
    await client.complete({ model: "test", messages: [] });
    expect(body?.tool_choice).toBeUndefined();
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
