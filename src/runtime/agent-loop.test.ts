import { describe, expect, it } from "vitest";

import { ExtensionHost } from "./extension-host.ts";
import { defineTool } from "./define-tool.ts";
import { Type } from "./schema.ts";
import { DEFAULT_MAX_TURNS, deriveTurnIndex, runAgentLoop, toolCallFingerprint } from "./agent-loop.ts";

import type { ChatMessage, LlmClient, StreamEvent, TurnEndPayload } from "./types.ts";

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

  it("keeps stable system prefix and places dynamic turn_start inject in the tail", async () => {
    let inject = "dynamic: branch=feat/x";
    const host = new ExtensionHost();
    host.on("turn_start", () => inject);
    const seen: ChatMessage[][] = [];
    const client: LlmClient = {
      async complete(request) {
        seen.push([...request.messages]);
        return { content: `reply-${seen.length}`, toolCalls: [] };
      },
    };

    const first = await runAgentLoop("first prompt", {
      host,
      client,
      model: "stub",
      systemPrompt: "STABLE_SYSTEM_V1",
    });
    const firstMsgs = seen[0]!;
    expect(firstMsgs[0]).toEqual({ role: "system", content: "STABLE_SYSTEM_V1" });
    expect(firstMsgs.at(-1)).toEqual({ role: "user", content: "first prompt" });
    expect(firstMsgs.at(-2)).toEqual({ role: "system", content: "dynamic: branch=feat/x" });
    // Stable at head; dynamic inject immediately before current user (tail of prefix).
    expect(firstMsgs.findIndex((message) => message.content === "STABLE_SYSTEM_V1")).toBe(0);
    expect(firstMsgs.findIndex((message) => message.content === "dynamic: branch=feat/x"))
      .toBe(firstMsgs.length - 2);

    inject = "dynamic: branch=feat/y";
    await runAgentLoop("second prompt", {
      host,
      client,
      model: "stub",
      systemPrompt: "STABLE_SYSTEM_V1",
      priorMessages: first.messages,
    });
    const secondMsgs = seen[1]!;
    expect(secondMsgs[0]).toEqual({ role: "system", content: "STABLE_SYSTEM_V1" });
    expect(secondMsgs.at(-1)).toEqual({ role: "user", content: "second prompt" });
    expect(secondMsgs.at(-2)).toEqual({ role: "system", content: "dynamic: branch=feat/y" });
    // Prior history retained between stable head and dynamic tail.
    expect(secondMsgs.some((message) => message.content === "first prompt")).toBe(true);
    expect(secondMsgs.some((message) => message.content === "reply-1")).toBe(true);
    // First system must remain the original stable prompt (not refreshed to inject).
    expect(secondMsgs.filter((message) => message.role === "system")[0]?.content)
      .toBe("STABLE_SYSTEM_V1");
  });
});

describe("runAgentLoop tool_result hooks", () => {
  it("does not let empty hook content wipe real tool output", async () => {
    const host = new ExtensionHost();
    host.registerTool(defineTool({
      name: "read",
      description: "read",
      parameters: Type.Object({ path: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "1|# real worktree body\n2|ok" }] };
      },
    }));
    // Broken-style hook: returns empty content blocks (old denoise mis-parse).
    host.on("tool_result", () => ({
      content: [{ type: "text", text: "" }],
      isError: false,
    }));

    const toolBodies: string[] = [];
    let calls = 0;
    const client: LlmClient = {
      async complete(request) {
        calls += 1;
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [{ id: "r1", name: "read", arguments: { path: "README.md" } }],
          };
        }
        for (const message of request.messages) {
          if (message.role === "tool" && typeof message.content === "string") {
            toolBodies.push(message.content);
          }
        }
        return { content: "done", toolCalls: [] };
      },
    };

    await runAgentLoop("read file", { host, client, model: "stub" });
    expect(toolBodies.some((body) => body.includes("real worktree body"))).toBe(true);
    expect(toolBodies.every((body) => body.length > 0)).toBe(true);
  });

  it("applies nested-compatible denoise content when non-empty", async () => {
    const host = new ExtensionHost();
    host.registerTool(defineTool({
      name: "bash",
      description: "bash",
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        return {
          content: [{
            type: "text",
            text: "exit_code=0\n\nstdout:\nfull listing here\n\n\nstderr:\n",
          }],
        };
      },
    }));
    host.on("tool_result", (payload) => {
      // Simulate fixed evolve: read nested result and return non-empty denoise.
      const record = payload as {
        result?: { content?: Array<{ type: string; text: string }> };
      };
      const original = record.result?.content?.[0]?.text ?? "";
      expect(original).toContain("full listing here");
      return {
        content: [{ type: "text", text: original.replace("full listing here", "denoised listing") }],
        isError: false,
      };
    });

    const toolBodies: string[] = [];
    let calls = 0;
    const client: LlmClient = {
      async complete(request) {
        calls += 1;
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [{ id: "b1", name: "bash", arguments: { command: "ls" } }],
          };
        }
        for (const message of request.messages) {
          if (message.role === "tool" && typeof message.content === "string") {
            toolBodies.push(message.content);
          }
        }
        return { content: "done", toolCalls: [] };
      },
    };

    await runAgentLoop("list", { host, client, model: "stub" });
    expect(toolBodies.some((body) => body.includes("denoised listing"))).toBe(true);
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

describe("runAgentLoop maxTurns default", () => {
  it("defaults to DEFAULT_MAX_TURNS (24)", () => {
    expect(DEFAULT_MAX_TURNS).toBe(24);
  });

  it("stops after maxTurns provider requests when tools never idle", async () => {
    const host = new ExtensionHost();
    let executes = 0;
    host.registerTool(defineTool({
      name: "ping",
      description: "ping",
      parameters: Type.Object({ n: Type.Number() }),
      async execute() {
        executes += 1;
        return { content: [{ type: "text", text: "pong" }] };
      },
    }));
    let providerCalls = 0;
    const client: LlmClient = {
      async complete() {
        providerCalls += 1;
        return {
          content: "",
          toolCalls: [{ id: `c${providerCalls}`, name: "ping", arguments: { n: providerCalls } }],
        };
      },
    };
    const result = await runAgentLoop("loop", {
      host,
      client,
      model: "stub",
      maxTurns: 5,
      repeatToolLimit: 0,
    });
    expect(providerCalls).toBe(5);
    expect(executes).toBe(5);
    expect(result.turns).toBe(5);
  });
});

describe("runAgentLoop repeat tool fuse", () => {
  it("blocks identical tool+args after the limit without executing again", async () => {
    const host = new ExtensionHost();
    let executes = 0;
    host.registerTool(defineTool({
      name: "read_stub",
      description: "read stub",
      parameters: Type.Object({ path: Type.String() }),
      async execute() {
        executes += 1;
        return { content: [{ type: "text", text: "body" }] };
      },
    }));
    let calls = 0;
    const client: LlmClient = {
      async complete() {
        calls += 1;
        if (calls <= 4) {
          return {
            content: "",
            toolCalls: [{ id: `r${calls}`, name: "read_stub", arguments: { path: "a.ts" } }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    };
    const result = await runAgentLoop("repeat", {
      host,
      client,
      model: "stub",
      repeatToolLimit: 3,
    });
    expect(executes).toBe(3);
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(4);
    expect(toolMessages.at(-1)?.content).toMatch(/repeated tool blocked/i);
    expect(result.toolErrors).toBeGreaterThanOrEqual(1);
    expect(result.finalText).toBe("done");
  });

  it("resets the streak when arguments change", async () => {
    const host = new ExtensionHost();
    let executes = 0;
    host.registerTool(defineTool({
      name: "read_stub",
      description: "read stub",
      parameters: Type.Object({ path: Type.String() }),
      async execute() {
        executes += 1;
        return { content: [{ type: "text", text: "body" }] };
      },
    }));
    let calls = 0;
    const client: LlmClient = {
      async complete() {
        calls += 1;
        if (calls <= 4) {
          return {
            content: "",
            toolCalls: [{
              id: `r${calls}`,
              name: "read_stub",
              arguments: { path: calls % 2 === 0 ? "b.ts" : "a.ts" },
            }],
          };
        }
        return { content: "done", toolCalls: [] };
      },
    };
    await runAgentLoop("alternate", {
      host,
      client,
      model: "stub",
      repeatToolLimit: 2,
    });
    expect(executes).toBe(4);
  });

  it("fingerprints ignore argument key order", () => {
    expect(toolCallFingerprint({ name: "x", arguments: { a: 1, b: 2 } }))
      .toBe(toolCallFingerprint({ name: "x", arguments: { b: 2, a: 1 } }));
  });
});

describe("runAgentLoop turn_end contract", () => {
  it("emits turnIndex, message, toolResults, and outcome (not prompt-only)", async () => {
    const host = new ExtensionHost();
    host.registerTool(defineTool({
      name: "read_stub",
      description: "read",
      parameters: Type.Object({ path: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "file body" }] };
      },
    }));
    let calls = 0;
    const client: LlmClient = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [{ id: "c1", name: "read_stub", arguments: { path: "a.ts" } }],
          };
        }
        return { content: "- [x] verify turn end", toolCalls: [] };
      },
    };
    const turnEnds: TurnEndPayload[] = [];
    host.on("turn_end", (payload) => {
      turnEnds.push(payload as TurnEndPayload);
    });

    await runAgentLoop("read then answer", { host, client, model: "stub" });

    expect(turnEnds).toHaveLength(1);
    const turn = turnEnds[0]!;
    expect(turn.turnIndex).toBe(1);
    expect(turn.prompt).toBe("read then answer");
    expect(turn.message).toEqual({ content: "- [x] verify turn end" });
    expect(turn.toolResults).toHaveLength(1);
    expect(turn.toolResults[0]).toMatchObject({
      toolCallId: "c1",
      toolName: "read_stub",
      content: "file body",
      isError: false,
    });
    expect(turn.outcome).toBe("success");
    // Regression lock: payload must not be the old `{ prompt }` shape only.
    expect("toolResults" in turn).toBe(true);
    expect("message" in turn).toBe(true);
    expect("turnIndex" in turn).toBe(true);
  });

  it("increments turnIndex across multi-prompt priorMessages", async () => {
    const host = new ExtensionHost();
    const client: LlmClient = {
      async complete() {
        return { content: "ok", toolCalls: [] };
      },
    };
    const turnEnds: TurnEndPayload[] = [];
    host.on("turn_end", (payload) => {
      turnEnds.push(payload as TurnEndPayload);
    });

    const first = await runAgentLoop("first", { host, client, model: "stub" });
    await runAgentLoop("second", {
      host,
      client,
      model: "stub",
      priorMessages: first.messages,
    });

    expect(turnEnds.map((turn) => turn.turnIndex)).toEqual([1, 2]);
    expect(turnEnds[1]?.prompt).toBe("second");
    expect(turnEnds[1]?.message).toEqual({ content: "ok" });
  });

  it("emits cancelled turn_end when aborted before provider", async () => {
    const host = new ExtensionHost();
    const controller = new AbortController();
    controller.abort();
    const client: LlmClient = {
      async complete() {
        return { content: "should not run", toolCalls: [] };
      },
    };
    const turnEnds: TurnEndPayload[] = [];
    host.on("turn_end", (payload) => {
      turnEnds.push(payload as TurnEndPayload);
    });

    const result = await runAgentLoop("abort me", {
      host,
      client,
      model: "stub",
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.outcome).toBe("cancelled");
    expect(turnEnds[0]?.turnIndex).toBe(1);
    expect(turnEnds[0]?.message).toBeNull();
    expect(turnEnds[0]?.toolResults).toEqual([]);
  });

  it("deriveTurnIndex is 1-based on prior user messages", () => {
    expect(deriveTurnIndex(undefined)).toBe(1);
    expect(deriveTurnIndex([])).toBe(1);
    expect(deriveTurnIndex([
      { role: "system", content: "s" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ])).toBe(2);
  });
});
