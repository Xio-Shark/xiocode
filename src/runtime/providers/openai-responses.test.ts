import { describe, expect, it } from "vitest";

import { createLlmClient } from "./client.ts";
import { buildResponsesInput } from "./openai-responses.ts";
import { resolveModelApi } from "./wire-api.ts";

import type { ProviderRegistration, StreamEvent } from "../types.ts";

const OPENCODE: ProviderRegistration = {
  name: "opencode",
  api: "openai-completions",
  baseUrl: "https://opencode.ai/zen/go/v1",
  sessionHeader: "x-opencode-session",
  models: [{ id: "deepseek-v4-flash", name: "deepseek-v4-flash", reasoning: true }],
};

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function capture(response: () => Response): { calls: Captured[]; fetchImpl: typeof fetch } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return response();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (value: unknown) => () => new Response(JSON.stringify(value), { status: 200 });
const sse = (events: readonly unknown[]) => () =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200 });

describe("resolveModelApi", () => {
  it("routes OpenCode model families to the protocol the gateway serves them on", () => {
    expect(resolveModelApi(OPENCODE, "gpt-6-luna")).toBe("openai-responses");
    expect(resolveModelApi(OPENCODE, "grok-4.7")).toBe("openai-responses");
    expect(resolveModelApi(OPENCODE, "muse-spark-1.3-contributor")).toBe("openai-responses");
    expect(resolveModelApi(OPENCODE, "minimax-m3")).toBe("anthropic-messages");
    expect(resolveModelApi(OPENCODE, "qwen3.8-max")).toBe("anthropic-messages");
    expect(resolveModelApi(OPENCODE, "kimi-k3")).toBe("openai-completions");
  });

  it("lets model_apis override the family table, and leaves other hosts alone", () => {
    expect(resolveModelApi({ ...OPENCODE, modelApis: { "grok-4.7": "openai-completions" } }, "grok-4.7"))
      .toBe("openai-completions");
    expect(resolveModelApi({ ...OPENCODE, baseUrl: "https://api.openai.com/v1" }, "gpt-6-luna"))
      .toBe("openai-completions");
  });
});

describe("per-model wire API", () => {
  it("posts each model to its endpoint with the session header, from one provider", async () => {
    const { calls, fetchImpl } = capture(json({ output: [], content: [], choices: [{ message: { content: "" } }] }));
    const client = createLlmClient({
      registration: OPENCODE,
      apiKey: "k",
      fetchImpl,
      identity: { sessionId: "s1", userAgent: "xiocode/test" },
    });
    for (const model of ["gpt-6-luna", "minimax-m3", "kimi-k3"]) {
      await client.complete({ model, messages: [{ role: "user", content: "hi" }] });
    }
    expect(calls.map((call) => call.url)).toEqual([
      "https://opencode.ai/zen/go/v1/responses",
      "https://opencode.ai/zen/go/v1/messages",
      "https://opencode.ai/zen/go/v1/chat/completions",
    ]);
    expect(calls.map((call) => call.headers["x-opencode-session"])).toEqual(["s1", "s1", "s1"]);
    expect(calls[0]!.headers.authorization).toBe("Bearer k");
    expect(calls[1]!.headers["x-api-key"]).toBe("k");
  });
});

describe("OpenAI Responses client", () => {
  it("sends history as input items and tools in the flat function shape", async () => {
    const { calls, fetchImpl } = capture(json({ output: [] }));
    const client = createLlmClient({ registration: OPENCODE, apiKey: "k", fetchImpl });
    await client.complete({
      model: "gpt-6-luna",
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "q" }],
      tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } }],
      maxTokens: 100,
      parallelToolCalls: true,
      thinkingLevel: "low",
    });
    expect(calls[0]!.body).toMatchObject({
      model: "gpt-6-luna",
      input: [{ role: "system", content: "sys" }, { role: "user", content: "q" }],
      tools: [{ type: "function", name: "read", description: "Read", parameters: { type: "object" } }],
      max_output_tokens: 100,
      parallel_tool_calls: true,
      store: false,
      stream: false,
      reasoning: { effort: "low", summary: "auto" },
    });
  });

  it("turns tool calls and their results into function_call items", () => {
    expect(buildResponsesInput([
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: { path: "a" } }] },
      { role: "tool", toolCallId: "c1", content: "body" },
      { role: "assistant", content: "done" },
    ])).toEqual([
      { role: "user", content: "q" },
      { type: "function_call", call_id: "c1", name: "read", arguments: "{\"path\":\"a\"}" },
      { type: "function_call_output", call_id: "c1", output: "body" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("reads text, tool calls and usage from a completed response", async () => {
    const { fetchImpl } = capture(json({
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", content: [{ type: "output_text", text: "hello" }] },
        { type: "function_call", call_id: "c1", name: "read", arguments: "{\"path\":\"a\"}" },
      ],
      usage: {
        input_tokens: 50,
        output_tokens: 7,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens_details: { reasoning_tokens: 3 },
      },
    }));
    const client = createLlmClient({ registration: OPENCODE, apiKey: "k", fetchImpl });
    const response = await client.complete({ model: "gpt-6-luna", messages: [] });
    expect(response.content).toBe("hello");
    expect(response.toolCalls).toEqual([{ id: "c1", name: "read", arguments: { path: "a" } }]);
    expect(response.usage).toEqual({ inputTokens: 50, outputTokens: 7, cacheTokens: 20, reasoningTokens: 3 });
  });

  it("streams text, reasoning summaries and tool calls", async () => {
    const { calls, fetchImpl } = capture(sse([
      { type: "response.created" },
      { type: "response.reasoning_summary_text.delta", delta: "thinking" },
      { type: "response.output_text.delta", output_index: 0, delta: "he" },
      { type: "response.output_text.delta", output_index: 0, delta: "llo" },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "c1", name: "read", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: "{\"path\":" },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: "\"a\"}" },
      { type: "response.function_call_arguments.done", output_index: 1, arguments: "{\"path\":\"a\"}" },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } },
    ]));
    const client = createLlmClient({ registration: OPENCODE, apiKey: "k", fetchImpl });
    const events: StreamEvent[] = [];
    for await (const event of client.completeStream!({ model: "grok-4.7", messages: [] })) events.push(event);
    expect(calls[0]!.body.stream).toBe(true);
    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([{ type: "thinking_delta", text: "thinking" }]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      content: "hello",
      toolCalls: [{ id: "c1", name: "read", arguments: { path: "a" } }],
      usage: { inputTokens: 10, outputTokens: 2 },
    });
  });

  it("fails the stream when the gateway reports a failed response", async () => {
    const { fetchImpl } = capture(sse([
      { type: "response.failed", response: { error: { message: "upstream overloaded" } } },
    ]));
    const client = createLlmClient({ registration: OPENCODE, apiKey: "k", fetchImpl });
    const drain = async () => {
      for await (const _ of client.completeStream!({ model: "gpt-6-luna", messages: [] })) void _;
    };
    await expect(drain()).rejects.toThrow("upstream overloaded");
  });

  it("does not turn a truncated SSE stream into a successful reply", async () => {
    const { fetchImpl } = capture(sse([{ type: "response.output_text.delta", delta: "partial" }]));
    const client = createLlmClient({ registration: OPENCODE, apiKey: "k", fetchImpl });
    const drain = async () => {
      for await (const event of client.completeStream!({ model: "gpt-6-luna", messages: [] })) {
        expect(event.type).not.toBe("done");
      }
    };
    await expect(drain()).rejects.toThrow("before a terminal response event");
  });

  it("rejects a failed non-streaming response even when HTTP status is 200", async () => {
    const { fetchImpl } = capture(json({ status: "failed", error: { message: "upstream failed" } }));
    const client = createLlmClient({ registration: OPENCODE, apiKey: "k", fetchImpl });
    await expect(client.complete({ model: "gpt-6-luna", messages: [] })).rejects.toThrow("upstream failed");
  });
});
