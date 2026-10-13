import { describe, expect, it, vi } from "vitest";
import { runAgentLoop, type AgentLoopCheckpoint } from "./agent-loop.ts";
import { ExtensionHost } from "./extension-host.ts";
import type { ChatMessage } from "./types.ts";

const messages: ChatMessage[] = [
  { role: "system", content: "original system" },
  { role: "user", content: "original task" },
  { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read", arguments: { path: "a" } }] },
  { role: "tool", toolCallId: "r1", content: "observed value" },
];
const checkpoint = (): AgentLoopCheckpoint => ({ phase: "awaiting_provider", messages: structuredClone(messages) });

describe("resume at a provider boundary", () => {
  it("preserves exact context and does not append another user prompt or rerun old tools", async () => {
    const saved = checkpoint();
    const host = new ExtensionHost();
    host.on("turn_start", () => "new context must not contaminate the checkpoint");
    const complete = vi.fn(async (request) => {
      expect(request.messages).toEqual(messages);
      return { content: "done", toolCalls: [] };
    });
    const result = await runAgentLoop("original task", {
      host, client: { complete }, model: "fixture", resumeFrom: saved,
    });
    expect(result.success).toBe(true);
    expect(result.toolCalls).toBe(0);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(saved.messages).toEqual(messages);
    expect(result.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it.each(["turn_started", "tool_batch_running", "turn_complete"] as const)("rejects %s before calling the provider", async (phase) => {
    const complete = vi.fn();
    await expect(runAgentLoop("task", {
      host: new ExtensionHost(), client: { complete }, model: "fixture", resumeFrom: { ...checkpoint(), phase },
    })).rejects.toThrow("awaiting_provider");
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects mixing new conversation history with a saved checkpoint", async () => {
    await expect(runAgentLoop("task", {
      host: new ExtensionHost(), client: { complete: vi.fn() }, model: "fixture",
      resumeFrom: checkpoint(), priorMessages: [],
    })).rejects.toThrow("priorMessages");
  });

  it("rejects a checkpoint taken before all tool results arrived", async () => {
    await expect(runAgentLoop("task", {
      host: new ExtensionHost(), client: { complete: vi.fn() }, model: "fixture",
      resumeFrom: { phase: "awaiting_provider", messages: messages.slice(0, -1) },
    })).rejects.toThrow("complete tool batches");
  });
});
