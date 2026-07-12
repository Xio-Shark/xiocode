import { describe, expect, it } from "vitest";

import { ExtensionHost } from "./extension-host.ts";
import { defineTool } from "./define-tool.ts";
import { Type } from "./schema.ts";
import { runAgentLoop } from "./agent-loop.ts";

import type { ChatMessage, LlmClient, StreamEvent } from "./types.ts";

describe("runAgentLoop context wiring", () => {
  it("merges turn_start return value into outbound provider messages", async () => {
    const host = new ExtensionHost();
    host.on("turn_start", () => "git: main\nstatus: clean");
    let seenMessages: ChatMessage[] = [];
    const client: LlmClient = {
      async complete(request) {
        seenMessages = [...request.messages];
        return { content: "ok", toolCalls: [] };
      },
    };
    await runAgentLoop("implement feature", { host, client, model: "stub" });
    expect(seenMessages.some((message) =>
      message.role === "system" && message.content.includes("git: main")
    )).toBe(true);
    expect(seenMessages.some((message) => message.role === "user" && message.content === "implement feature")).toBe(true);
  });
});

describe("runAgentLoop parallel tools", () => {
  it("runs independent sleep tools faster than serial wall-clock", async () => {
    const sleepMs = 80;
    const makeHost = () => {
      const host = new ExtensionHost();
      host.registerTool(defineTool({
        name: "sleep",
        description: "sleep",
        parameters: Type.Object({ ms: Type.Number() }),
        async execute(_id, params) {
          const ms = typeof params.ms === "number" ? params.ms : 50;
          await new Promise((resolve) => setTimeout(resolve, ms));
          return { content: [{ type: "text", text: `slept ${ms}` }] };
        },
      }));
      return host;
    };
    const makeClient = (): LlmClient => {
      let calls = 0;
      return {
        async complete() {
          calls += 1;
          if (calls === 1) {
            return {
              content: "",
              toolCalls: [
                { id: "1", name: "sleep", arguments: { ms: sleepMs } },
                { id: "2", name: "sleep", arguments: { ms: sleepMs } },
              ],
            };
          }
          return { content: "done", toolCalls: [] };
        },
      };
    };

    const serialStarted = Date.now();
    await runAgentLoop("sleep twice serial", {
      host: makeHost(),
      client: makeClient(),
      model: "stub",
      parallelToolCalls: false,
    });
    const serialElapsed = Date.now() - serialStarted;

    const parallelStarted = Date.now();
    const result = await runAgentLoop("sleep twice parallel", {
      host: makeHost(),
      client: makeClient(),
      model: "stub",
      parallelToolCalls: true,
    });
    const parallelElapsed = Date.now() - parallelStarted;

    expect(result.toolCalls).toBe(2);
    // PRD: parallel wall-clock < 70% of serial sum for independent tools
    expect(parallelElapsed).toBeLessThan(serialElapsed * 0.7);
  });
});

describe("runAgentLoop write serialization", () => {
  it("runs write tools one at a time even when parallelToolCalls is true", async () => {
    const host = new ExtensionHost();
    let inFlight = 0;
    let maxInFlight = 0;
    host.registerTool(defineTool({
      name: "write",
      description: "write",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute(_id, params) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
        return { content: [{ type: "text", text: `wrote ${String(params.path)}` }] };
      },
    }));
    let calls = 0;
    const client: LlmClient = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "1", name: "write", arguments: { path: "a.ts", content: "a" } },
              { id: "2", name: "write", arguments: { path: "b.ts", content: "b" } },
            ],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    };
    await runAgentLoop("write two files", {
      host,
      client,
      model: "stub",
      parallelToolCalls: true,
    });
    expect(maxInFlight).toBe(1);
  });
});

describe("runAgentLoop session history", () => {
  it("appends the second prompt onto prior messages", async () => {
    const host = new ExtensionHost();
    const seenLengths: number[] = [];
    const client: LlmClient = {
      async complete(request) {
        seenLengths.push(request.messages.length);
        return { content: `reply-${seenLengths.length}`, toolCalls: [] };
      },
    };
    const first = await runAgentLoop("first", { host, client, model: "stub" });
    const second = await runAgentLoop("second", {
      host,
      client,
      model: "stub",
      priorMessages: first.messages,
    });
    expect(seenLengths[0]).toBeGreaterThanOrEqual(2);
    expect(seenLengths[1]).toBeGreaterThan(seenLengths[0]!);
    expect(second.messages.some((message) => message.content === "first")).toBe(true);
    expect(second.messages.some((message) => message.content === "second")).toBe(true);
  });

  it("fails explicitly instead of trimming when max_session_messages is exceeded", async () => {
    const priorMessages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "u4" },
      { role: "assistant", content: "a4" },
    ];
    const host = new ExtensionHost();
    const client: LlmClient = {
      async complete() {
        return { content: "should not run", toolCalls: [] };
      },
    };
    await expect(runAgentLoop("next", {
      host,
      client,
      model: "stub",
      priorMessages,
      maxSessionMessages: 8,
    })).rejects.toThrow(/run \/compact or start a new session/i);
  });
});

describe("runAgentLoop abort", () => {
  it("exits cleanly when AbortSignal fires before completion", async () => {
    const host = new ExtensionHost();
    const controller = new AbortController();
    const client: LlmClient = {
      async complete(_request, options) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          options?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted.", "AbortError"));
          }, { once: true });
        });
        return { content: "late", toolCalls: [] };
      },
    };
    const pending = runAgentLoop("cancel me", {
      host,
      client,
      model: "stub",
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.success).toBe(false);
  });

  it("closes remaining tool calls with interrupted results instead of leaving orphan history", async () => {
    const host = new ExtensionHost();
    const controller = new AbortController();
    host.registerTool(defineTool({
      name: "step",
      description: "step",
      parameters: Type.Object({ index: Type.Number() }),
      async execute(_id, params) {
        if (params.index === 1) controller.abort();
        return { content: [{ type: "text", text: `step ${String(params.index)}` }] };
      },
    }));
    const client: LlmClient = {
      async complete() {
        return {
          content: "",
          toolCalls: [
            { id: "one", name: "step", arguments: { index: 1 } },
            { id: "two", name: "step", arguments: { index: 2 } },
          ],
        };
      },
    };

    const result = await runAgentLoop("cancel tools", {
      host,
      client,
      model: "stub",
      signal: controller.signal,
      parallelToolCalls: false,
    });

    expect(result.cancelled).toBe(true);
    expect(result.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId))
      .toEqual(["one", "two"]);
    expect(result.messages.find((message) => message.toolCallId === "two")?.content)
      .toMatch(/completion unknown/i);
  });
});

describe("runAgentLoop checkpoints", () => {
  it("publishes provider-valid snapshots around a tool batch", async () => {
    const host = new ExtensionHost();
    host.registerTool(defineTool({
      name: "read_once",
      description: "read once",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    }));
    let calls = 0;
    const client: LlmClient = {
      async complete() {
        calls += 1;
        return calls === 1
          ? { content: "", toolCalls: [{ id: "read-1", name: "read_once", arguments: {} }] }
          : { content: "done", toolCalls: [] };
      },
    };
    const checkpoints: Array<{ phase: string; pending: readonly string[]; messages: readonly ChatMessage[] }> = [];

    await runAgentLoop("checkpoint", {
      host,
      client,
      model: "stub",
      onCheckpoint: (checkpoint) => {
        checkpoints.push({
          phase: checkpoint.phase,
          pending: checkpoint.pendingTools?.map((tool) => tool.id) ?? [],
          messages: checkpoint.messages,
        });
      },
    });

    expect(checkpoints.some((checkpoint) => checkpoint.phase === "turn_started")).toBe(true);
    expect(checkpoints.some((checkpoint) =>
      checkpoint.phase === "tool_batch_running" && checkpoint.pending.includes("read-1")
    )).toBe(true);
    const completedTool = checkpoints.find((checkpoint) =>
      checkpoint.phase === "tool_batch_running" && checkpoint.pending.length === 0
    );
    expect(completedTool?.messages.some((message) => message.toolCallId === "read-1")).toBe(true);
    expect(checkpoints.at(-1)?.phase).toBe("turn_complete");
  });
});

describe("runAgentLoop streaming", () => {
  it("forwards text deltas in order before the final assistant text", async () => {
    const host = new ExtensionHost();
    const deltas: string[] = [];
    const client: LlmClient = {
      async complete() {
        return { content: "hello world", toolCalls: [] };
      },
      async *completeStream(): AsyncIterable<StreamEvent> {
        yield { type: "text_delta", text: "hello" };
        yield { type: "text_delta", text: " world" };
        yield {
          type: "done",
          content: "hello world",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 2, cacheTokens: null, reasoningTokens: null },
        };
      },
    };
    const result = await runAgentLoop("stream", {
      host,
      client,
      model: "stub",
      onAssistantDelta: (text) => deltas.push(text),
    });
    expect(deltas).toEqual(["hello", " world"]);
    expect(result.finalText).toBe("hello world");
  });

  it("forwards thinking_delta without mixing into assistant content", async () => {
    const host = new ExtensionHost();
    const thinking: string[] = [];
    const deltas: string[] = [];
    const client: LlmClient = {
      async complete() {
        return { content: "answer", toolCalls: [] };
      },
      async *completeStream(): AsyncIterable<StreamEvent> {
        yield { type: "thinking_delta", text: "reason" };
        yield { type: "text_delta", text: "answer" };
        yield {
          type: "done",
          content: "answer",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheTokens: null, reasoningTokens: null },
        };
      },
    };
    const result = await runAgentLoop("stream", {
      host,
      client,
      model: "stub",
      onThinkingDelta: (text) => thinking.push(text),
      onAssistantDelta: (text) => deltas.push(text),
    });
    expect(thinking).toEqual(["reason"]);
    expect(deltas).toEqual(["answer"]);
    expect(result.finalText).toBe("answer");
    expect(result.messages.some((message) => message.content.includes("reason"))).toBe(false);
  });
});
