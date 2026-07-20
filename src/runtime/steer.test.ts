import { describe, expect, it } from "vitest";

import { ExtensionHost } from "./extension-host.ts";
import { defineTool } from "./define-tool.ts";
import { Type } from "./schema.ts";
import { runAgentLoop } from "./agent-loop.ts";
import { createRuntimeEventEmitter } from "./events/index.ts";
import { createScriptedLlmClient, parseAgentTape } from "./providers/scripted/index.ts";
import { createPromptRunner } from "./session-lifecycle.ts";
import { SessionHistory } from "./context-compaction.ts";
import {
  formatSteerUserMessage,
  resolveSteerMode,
  SteerMailbox,
} from "./steer.ts";

import type { LlmClient, StreamEvent } from "./types.ts";
import type { RuntimeEventV1 as RE } from "./events/types.ts";

describe("SteerMailbox", () => {
  it("resolves auto mode from busy flag", () => {
    expect(resolveSteerMode("auto", true)).toBe("hard");
    expect(resolveSteerMode("auto", false)).toBe("soft");
    expect(resolveSteerMode("soft", true)).toBe("soft");
  });

  it("drains soft without removing hard", () => {
    const box = new SteerMailbox();
    box.enqueue({ text: "soft-1", mode: "soft" });
    box.enqueue({ text: "hard-1", mode: "hard" });
    box.enqueue({ text: "soft-2", mode: "soft" });
    expect(box.drainSoft().map((r) => r.text)).toEqual(["soft-1", "soft-2"]);
    expect(box.takeHard()?.text).toBe("hard-1");
    expect(box.hasPending()).toBe(false);
  });

  it("queues and clears follow-ups independently of steer", () => {
    const box = new SteerMailbox();
    box.enqueue({ text: "soft", mode: "soft" });
    box.enqueueFollowUp({ text: "fu-1" });
    box.enqueueFollowUp({ text: "fu-2" });
    expect(box.hasFollowUp()).toBe(true);
    expect(box.listFollowUp().map((r) => r.text)).toEqual(["fu-1", "fu-2"]);
    expect(box.clearFollowUp().map((r) => r.text)).toEqual(["fu-1", "fu-2"]);
    expect(box.hasFollowUp()).toBe(false);
    expect(box.drainSoft().map((r) => r.text)).toEqual(["soft"]);
  });
});

describe("soft steer at boundaries", () => {
  it("applies soft steer after tool batch without abort", async () => {
    const mailbox = new SteerMailbox();
    const host = new ExtensionHost();
    host.registerTool(defineTool({
      name: "echo",
      description: "echo",
      parameters: Type.Object({ q: Type.String() }),
      async execute() {
        mailbox.enqueue({ text: "redirect now", mode: "soft" });
        return { content: [{ type: "text", text: "pong" }] };
      },
    }));

    const tape = parseAgentTape({
      schema_version: "xio-agent-tape.v1",
      name: "soft-after-tool",
      turns: [
        {
          steps: [
            { type: "tool_call", id: "c1", name: "echo", arguments: { q: "a" } },
            { type: "done" },
          ],
        },
        {
          steps: [
            { type: "delta", channel: "text", chunks: ["after-steer"] },
            { type: "done" },
          ],
        },
      ],
    });
    // After soft inject, loop continues with another provider call — need 3rd turn for final?
    // Flow: turn0 tool, soft inject, turn1 should see steer message and produce final text.
    // tape has 2 turns: first tool, second text. Soft applies after tool → second call is turn1. Good.

    const bus = createRuntimeEventEmitter({ sessionId: "s", runId: "r" });
    const events: RE[] = [];
    bus.subscribe((e) => {
      events.push(e);
    });

    const result = await runAgentLoop("start", {
      host,
      client: createScriptedLlmClient({ tape }),
      model: "scripted",
      steerMailbox: mailbox,
      runtimeEvents: bus,
    });

    expect(result.finalText).toBe("after-steer");
    expect(result.cancelled).not.toBe(true);
    expect(result.messages.some((m) =>
      m.role === "user" && m.content.includes("[steer:soft]")
    )).toBe(true);
    expect(events.some((e) => e.event === "steer.applied" && e.payload.mode === "soft")).toBe(true);
  });

  it("keeps soft queued mid-stream until provider completion", async () => {
    const mailbox = new SteerMailbox();
    let released = false;
    const client: LlmClient = {
      async complete() {
        return { content: "unused", toolCalls: [] };
      },
      async *completeStream(): AsyncIterable<StreamEvent> {
        mailbox.enqueue({ text: "mid", mode: "soft" });
        yield { type: "text_delta", text: "a" };
        // Soft still queued during stream
        expect(mailbox.hasPending()).toBe(true);
        yield {
          type: "done",
          content: "a",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheTokens: null, reasoningTokens: null },
        };
        released = true;
      },
    };
    // After text completion, soft applies and continues — need another completeStream call.
    let calls = 0;
    const multi: LlmClient = {
      async complete() {
        return { content: "x", toolCalls: [] };
      },
      async *completeStream(): AsyncIterable<StreamEvent> {
        calls += 1;
        if (calls === 1) {
          mailbox.enqueue({ text: "mid", mode: "soft" });
          yield { type: "text_delta", text: "a" };
          yield {
            type: "done",
            content: "a",
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, cacheTokens: null, reasoningTokens: null },
          };
          return;
        }
        yield { type: "text_delta", text: "b" };
        yield {
          type: "done",
          content: "b",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheTokens: null, reasoningTokens: null },
        };
      },
    };

    const result = await runAgentLoop("go", {
      host: new ExtensionHost(),
      client: multi,
      model: "stub",
      steerMailbox: mailbox,
    });
    expect(result.finalText).toBe("b");
    expect(result.messages.some((m) => m.content.includes("[steer:soft] mid"))).toBe(true);
    void released;
  });
});

describe("hard steer", () => {
  it("aborts hang, returns hardSteerText, and prompt runner continues", async () => {
    const mailbox = new SteerMailbox();
    const controller = new AbortController();
    const tape = parseAgentTape({
      schema_version: "xio-agent-tape.v1",
      name: "hard-hang",
      turns: [
        {
          steps: [
            { type: "barrier", id: "hanging" },
            { type: "hang", ms: 60_000 },
            { type: "delta", channel: "text", chunks: ["should-not"] },
            { type: "done" },
          ],
        },
        {
          steps: [
            { type: "delta", channel: "text", chunks: ["steered-ok"] },
            { type: "done" },
          ],
        },
      ],
    });

    let releaseBarrier: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const client = createScriptedLlmClient({
      tape,
      async onBarrier(id) {
        if (id === "hanging") {
          // Request hard steer while hung, then abort.
          mailbox.enqueue({ text: "stop and do X", mode: "hard" });
          controller.abort();
          await gate;
        }
      },
      async sleep() {
        // hang is aborted via signal on completeStream abort
      },
    });

    const bus = createRuntimeEventEmitter({ sessionId: "s", runId: "r-hard" });
    const events: RE[] = [];
    bus.subscribe((e) => {
      events.push(e);
    });

    const host = new ExtensionHost();
    // Direct loop: abort mid-hang
    const pending = runAgentLoop("slow", {
      host,
      client,
      model: "scripted",
      signal: controller.signal,
      steerMailbox: mailbox,
      runtimeEvents: bus,
    });
    await new Promise<void>((r) => {
      setTimeout(r, 20);
    });
    releaseBarrier?.();
    const cancelled = await pending;
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.hardSteerText).toBe("stop and do X");
    expect(events.some((e) => e.event === "steer.requested" || e.event === "steer.applied")).toBe(true);
    expect(events.some((e) => e.event === "steer.applied" && e.payload.mode === "hard")).toBe(true);

    // Prompt runner continues after hard steer
    const mailbox2 = new SteerMailbox();
    let signal = new AbortController();
    const tape2 = parseAgentTape({
      schema_version: "xio-agent-tape.v1",
      name: "hard-continue",
      turns: [
        {
          steps: [
            { type: "barrier", id: "b" },
            { type: "hang", ms: 60_000 },
            { type: "done" },
          ],
        },
        {
          steps: [
            { type: "delta", channel: "text", chunks: ["continued"] },
            { type: "done" },
          ],
        },
      ],
    });
    let release2: (() => void) | undefined;
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    const client2 = createScriptedLlmClient({
      tape: tape2,
      async onBarrier() {
        mailbox2.enqueue({ text: "continue path", mode: "hard" });
        signal.abort();
        await gate2;
      },
      async sleep() {},
    });
    const history = new SessionHistory();
    const run = createPromptRunner({
      host: new ExtensionHost(),
      client: client2,
      model: { provider: "scripted", id: "scripted" },
      providerApi: "openai-completions",
      verify: { enabled: false, requireAllPass: true, repairTurns: 0, commands: [] },
      history,
      steerMailbox: mailbox2,
      getSignal: () => signal.signal,
      resetSignal: () => {
        signal = new AbortController();
        return signal.signal;
      },
    });
    const runnerPending = run("start hard");
    await new Promise<void>((r) => {
      setTimeout(r, 20);
    });
    release2?.();
    const out = await runnerPending;
    expect(out.text).toBe("continued");
    expect(out.cancelled).not.toBe(true);
    expect(out.success).toBe(true);
  });
});

describe("formatSteerUserMessage", () => {
  it("tags mode", () => {
    expect(formatSteerUserMessage("go", "hard")).toBe("[steer:hard] go");
  });
});

describe("follow-up queue", () => {
  it("drains soft before follow-up and does not preempt a tool batch", async () => {
    const mailbox = new SteerMailbox();
    const host = new ExtensionHost();
    host.registerTool(defineTool({
      name: "echo",
      description: "echo",
      parameters: Type.Object({ q: Type.String() }),
      async execute() {
        // Mid-tool: both soft and follow-up queued — soft applies after batch; follow-up waits.
        mailbox.enqueue({ text: "soft-first", mode: "soft" });
        mailbox.enqueueFollowUp({ text: "follow-later" });
        return { content: [{ type: "text", text: "pong" }] };
      },
    }));

    const tape = parseAgentTape({
      schema_version: "xio-agent-tape.v1",
      name: "follow-after-soft",
      turns: [
        {
          steps: [
            { type: "tool_call", id: "c1", name: "echo", arguments: { q: "a" } },
            { type: "done" },
          ],
        },
        {
          steps: [
            { type: "delta", channel: "text", chunks: ["after-soft"] },
            { type: "done" },
          ],
        },
        {
          steps: [
            { type: "delta", channel: "text", chunks: ["after-follow"] },
            { type: "done" },
          ],
        },
      ],
    });

    const bus = createRuntimeEventEmitter({ sessionId: "s", runId: "r-fu" });
    const events: RE[] = [];
    bus.subscribe((e) => {
      events.push(e);
    });

    const result = await runAgentLoop("start", {
      host,
      client: createScriptedLlmClient({ tape }),
      model: "scripted",
      steerMailbox: mailbox,
      runtimeEvents: bus,
    });

    expect(result.finalText).toBe("after-follow");
    expect(result.cancelled).not.toBe(true);
    const userTexts = result.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(userTexts.some((t) => t.includes("[steer:soft] soft-first"))).toBe(true);
    expect(userTexts.some((t) => t === "follow-later")).toBe(true);
    // Soft applied before follow-up in message order.
    const softIdx = result.messages.findIndex((m) => m.role === "user" && m.content.includes("soft-first"));
    const followIdx = result.messages.findIndex((m) => m.role === "user" && m.content === "follow-later");
    expect(softIdx).toBeGreaterThan(-1);
    expect(followIdx).toBeGreaterThan(softIdx);
    expect(events.some((e) => e.event === "steer.applied" && e.payload.mode === "soft")).toBe(true);
    expect(events.some((e) => e.event === "follow_up.applied")).toBe(true);
    expect(mailbox.hasFollowUp()).toBe(false);
  });

  it("does not double-drain the same follow-up", async () => {
    const mailbox = new SteerMailbox();
    mailbox.enqueueFollowUp({ text: "once-only" });
    const first = mailbox.takeFollowUp();
    const second = mailbox.takeFollowUp();
    expect(first?.text).toBe("once-only");
    expect(second).toBeUndefined();
  });

  it("discards follow-up on abort and never applies it", async () => {
    const mailbox = new SteerMailbox();
    const controller = new AbortController();
    mailbox.enqueueFollowUp({ text: "should-not-run" });

    const tape = parseAgentTape({
      schema_version: "xio-agent-tape.v1",
      name: "follow-abort",
      turns: [
        {
          steps: [
            { type: "barrier", id: "hanging" },
            { type: "hang", ms: 60_000 },
            { type: "delta", channel: "text", chunks: ["should-not"] },
            { type: "done" },
          ],
        },
      ],
    });

    let releaseBarrier: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const client = createScriptedLlmClient({
      tape,
      async onBarrier(id) {
        if (id === "hanging") {
          controller.abort();
          await gate;
        }
      },
      async sleep() {},
    });

    const bus = createRuntimeEventEmitter({ sessionId: "s", runId: "r-abort-fu" });
    const events: RE[] = [];
    bus.subscribe((e) => {
      events.push(e);
    });

    const pending = runAgentLoop("slow", {
      host: new ExtensionHost(),
      client,
      model: "scripted",
      signal: controller.signal,
      steerMailbox: mailbox,
      runtimeEvents: bus,
    });
    await new Promise<void>((r) => {
      setTimeout(r, 20);
    });
    releaseBarrier?.();
    const cancelled = await pending;
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.hardSteerText).toBeUndefined();
    expect(mailbox.hasFollowUp()).toBe(false);
    expect(events.some((e) => e.event === "follow_up.discarded")).toBe(true);
    expect(events.some((e) => e.event === "follow_up.applied")).toBe(false);
    expect(cancelled.messages.some((m) => m.content === "should-not-run")).toBe(false);
  });

  it("keeps follow-up queued across hard-steer continuation until natural end", async () => {
    const mailbox = new SteerMailbox();
    let signal = new AbortController();
    mailbox.enqueueFollowUp({ text: "after-hard-hop" });

    const tape = parseAgentTape({
      schema_version: "xio-agent-tape.v1",
      name: "follow-after-hard",
      turns: [
        {
          steps: [
            { type: "barrier", id: "b" },
            { type: "hang", ms: 60_000 },
            { type: "done" },
          ],
        },
        {
          steps: [
            { type: "delta", channel: "text", chunks: ["hard-done"] },
            { type: "done" },
          ],
        },
        {
          steps: [
            { type: "delta", channel: "text", chunks: ["follow-done"] },
            { type: "done" },
          ],
        },
      ],
    });

    let release2: (() => void) | undefined;
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    const client = createScriptedLlmClient({
      tape,
      async onBarrier() {
        mailbox.enqueue({ text: "hard path", mode: "hard" });
        signal.abort();
        await gate2;
      },
      async sleep() {},
    });
    const history = new SessionHistory();
    const run = createPromptRunner({
      host: new ExtensionHost(),
      client,
      model: { provider: "scripted", id: "scripted" },
      providerApi: "openai-completions",
      verify: { enabled: false, requireAllPass: true, repairTurns: 0, commands: [] },
      history,
      steerMailbox: mailbox,
      getSignal: () => signal.signal,
      resetSignal: () => {
        signal = new AbortController();
        return signal.signal;
      },
    });
    const runnerPending = run("start hard");
    await new Promise<void>((r) => {
      setTimeout(r, 20);
    });
    release2?.();
    const out = await runnerPending;
    expect(out.text).toBe("follow-done");
    expect(out.cancelled).not.toBe(true);
    expect(history.getMessages().some((m) => m.role === "user" && m.content === "after-hard-hop")).toBe(true);
    expect(mailbox.hasFollowUp()).toBe(false);
  });
});

describe("hard steer while tool open", () => {
  it("cancels open tool, applies steer text, and continues the run", async () => {
    const mailbox = new SteerMailbox();
    let signal = new AbortController();
    let toolStarted!: () => void;
    const toolStartedGate = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });

    const host = new ExtensionHost();
    host.registerTool(defineTool({
      name: "slow",
      description: "slow tool",
      parameters: Type.Object({ q: Type.String() }),
      async execute(_id, _args, ctx) {
        toolStarted();
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          };
          if (ctx?.signal?.aborted) {
            onAbort();
            return;
          }
          ctx?.signal?.addEventListener("abort", onAbort, { once: true });
          // Keep open until abort; never resolve successfully in this test.
          void resolve;
        });
        return { content: [{ type: "text", text: "should-not" }] };
      },
    }));

    const tape = parseAgentTape({
      schema_version: "xio-agent-tape.v1",
      name: "hard-open-tool",
      turns: [
        {
          steps: [
            { type: "tool_call", id: "t1", name: "slow", arguments: { q: "a" } },
            { type: "done" },
          ],
        },
        {
          steps: [
            { type: "delta", channel: "text", chunks: ["after-open-tool-steer"] },
            { type: "done" },
          ],
        },
      ],
    });

    const history = new SessionHistory();
    const run = createPromptRunner({
      host,
      client: createScriptedLlmClient({ tape }),
      model: { provider: "scripted", id: "scripted" },
      providerApi: "openai-completions",
      verify: { enabled: false, requireAllPass: true, repairTurns: 0, commands: [] },
      history,
      steerMailbox: mailbox,
      getSignal: () => signal.signal,
      resetSignal: () => {
        signal = new AbortController();
        return signal.signal;
      },
    });

    const pending = run("start with open tool");
    await toolStartedGate;
    mailbox.enqueue({ text: "do something else", mode: "hard" });
    signal.abort();

    const out = await pending;
    expect(out.text).toBe("after-open-tool-steer");
    expect(out.cancelled).not.toBe(true);
    expect(out.success).toBe(true);

    const messages = history.getMessages();
    const toolMsg = messages.find((m) => m.role === "tool" && m.toolCallId === "t1");
    expect(toolMsg?.content.toLowerCase()).toMatch(/cancel|interrupt|abort|unknown/);
    // Hard-steer hop continues with the steer text as the next user prompt (not mid-stream inject).
    expect(messages.some((m) => m.role === "user" && m.content.includes("do something else"))).toBe(true);
  });
});
