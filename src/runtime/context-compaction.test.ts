import { describe, expect, it } from "vitest";

import {
  CONTEXT_SUMMARY_NAME,
  ContextCompactionController,
  SessionHistory,
  compactSessionMessages,
} from "./context-compaction.ts";
import { registerContextCommands } from "./context-commands.ts";
import { ExtensionHost } from "./extension-host.ts";

import type { ChatMessage, LlmClient } from "./types.ts";

const baseHistory: readonly ChatMessage[] = [
  { role: "system", content: "system" },
  { role: "user", content: "old task" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call-1", name: "read", arguments: { path: "a.ts" } }],
  },
  { role: "tool", name: "read", toolCallId: "call-1", content: "file body" },
  { role: "assistant", content: "old result" },
  { role: "system", content: "fresh repository context" },
  { role: "user", content: "latest intent" },
  { role: "assistant", content: "latest answer" },
];

describe("compactSessionMessages", () => {
  it("summarizes older turns while retaining the latest complete turn verbatim", async () => {
    let summaryRequest = "";
    const client: LlmClient = {
      async complete(request) {
        summaryRequest = request.messages.at(-1)?.content ?? "";
        return { content: "Goal: continue latest intent.", toolCalls: [] };
      },
    };
    const result = await compactSessionMessages({
      messages: baseHistory,
      client,
      model: "stub",
      maxMessages: 8,
      focus: "keep file and test decisions",
    });

    expect(result.compacted).toBe(true);
    expect(result.messages[0]).toEqual({ role: "system", content: "system" });
    expect(result.messages[1]?.name).toBe(CONTEXT_SUMMARY_NAME);
    expect(result.messages.some((message) => message.content === "latest intent")).toBe(true);
    expect(result.messages.some((message) => message.toolCallId === "call-1")).toBe(false);
    expect(summaryRequest).toContain("keep file and test decisions");
    expect(summaryRequest).toContain("call-1");
  });

  it("returns a no-op without calling the provider when there is no older complete turn", async () => {
    let calls = 0;
    const client: LlmClient = {
      async complete() {
        calls += 1;
        return { content: "unused", toolCalls: [] };
      },
    };
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "only turn" },
      { role: "assistant", content: "answer" },
    ];
    const result = await compactSessionMessages({ messages, client, model: "stub", maxMessages: 8 });
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(calls).toBe(0);
  });

  it("passes cancellation to the summarizer and preserves the original messages", async () => {
    const controller = new AbortController();
    const client: LlmClient = {
      async complete(_request, options) {
        expect(options?.signal).toBe(controller.signal);
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    };
    controller.abort();
    await expect(compactSessionMessages({
      messages: baseHistory,
      client,
      model: "stub",
      maxMessages: 8,
      signal: controller.signal,
    })).rejects.toThrow(/aborted/i);
    expect(baseHistory[1]?.content).toBe("old task");
  });

  it("folds an existing summary into one replacement summary", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "system", name: CONTEXT_SUMMARY_NAME, content: "[context summary]\nold summary" },
      { role: "user", content: "middle" },
      { role: "assistant", content: "middle answer" },
      { role: "user", content: "latest" },
      { role: "assistant", content: "latest answer" },
    ];
    const client: LlmClient = {
      async complete() {
        return { content: "replacement summary", toolCalls: [] };
      },
    };
    const result = await compactSessionMessages({ messages, client, model: "stub", maxMessages: 8 });
    expect(result.messages.filter((message) => message.name === CONTEXT_SUMMARY_NAME)).toHaveLength(1);
  });

  it("retains assistant tool calls and all matching results as one recent turn", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "old" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "latest" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "one", name: "read", arguments: { path: "a" } },
          { id: "two", name: "read", arguments: { path: "b" } },
        ],
      },
      { role: "tool", toolCallId: "one", name: "read", content: "a" },
      { role: "tool", toolCallId: "two", name: "read", content: "b" },
      { role: "assistant", content: "done" },
    ];
    const client: LlmClient = {
      async complete() {
        return { content: "old summary", toolCalls: [] };
      },
    };
    const result = await compactSessionMessages({ messages, client, model: "stub", maxMessages: 8 });
    expect(result.messages.flatMap((message) => message.toolCalls ?? []).map((call) => call.id))
      .toEqual(["one", "two"]);
    expect(result.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId))
      .toEqual(["one", "two"]);
  });
});

describe("ContextCompactionController", () => {
  it("keeps history unchanged when summary generation fails", async () => {
    const history = new SessionHistory({ initialMessages: baseHistory });
    const events: string[] = [];
    const controller = new ContextCompactionController({
      history,
      getClient: () => ({
        async complete() {
          throw new Error("provider unavailable");
        },
      }),
      getModel: () => ({ provider: "test", id: "stub" }),
      maxMessages: 8,
      onUiEvent: (event) => events.push(event.stage),
    });

    await expect(controller.compact("manual")).rejects.toThrow("provider unavailable");
    expect(history.getMessages()).toEqual(baseHistory);
    expect(events).toEqual(["start", "failure"]);
  });

  it("does not publish a compacted projection when persistence fails", async () => {
    const history = new SessionHistory({
      initialMessages: baseHistory,
      persist: async () => {
        throw new Error("disk full");
      },
    });
    const controller = new ContextCompactionController({
      history,
      getClient: () => ({
        async complete() {
          return { content: "summary", toolCalls: [] };
        },
      }),
      getModel: () => ({ provider: "test", id: "stub" }),
      maxMessages: 8,
    });

    await expect(controller.compact("manual")).rejects.toThrow("disk full");
    expect(history.getMessages()).toEqual(baseHistory);
  });

  it("uses the configured budget as the automatic trigger", () => {
    const history = new SessionHistory({ initialMessages: baseHistory });
    const controller = new ContextCompactionController({
      history,
      getClient: () => ({ async complete() { return { content: "summary", toolCalls: [] }; } }),
      getModel: () => ({ provider: "test", id: "stub" }),
      maxMessages: 8,
    });
    expect(controller.needsAutomaticCompaction()).toBe(true);
  });
});

describe("registerContextCommands", () => {
  it("registers one compact command and forwards optional focus text", async () => {
    const host = new ExtensionHost();
    const calls: Array<{ mode: string; focus?: string }> = [];
    registerContextCommands({
      host,
      compact: async (mode, focus) => {
        calls.push({ mode, focus });
      },
    });

    await host.runCommand("compact", " keep tests and API decisions ");

    expect(host.listCommandEntries().filter((entry) => entry.name === "compact")).toHaveLength(1);
    expect(calls).toEqual([{ mode: "manual", focus: "keep tests and API decisions" }]);
  });
});
