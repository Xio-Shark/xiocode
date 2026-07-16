import { describe, expect, it } from "vitest";

import {
  createStdoutSessionUiSink,
  createStdoutSubagentUiBridge,
  formatToolOutputForDisplay,
  formatUsageStatus,
  previewText,
  toolCallDetail,
  toolResultOutput,
} from "./session-ui.ts";

describe("createStdoutSessionUiSink", () => {
  it("preserves streaming, tool, status, and cancellation output", () => {
    const chunks: string[] = [];
    const sink = createStdoutSessionUiSink((chunk) => chunks.push(chunk));

    sink.setStatus?.("sandbox", "clean");
    sink.onAssistantDelta?.("hel");
    sink.onAssistantDelta?.("lo");
    sink.onAssistantText?.("hello");
    sink.onToolStart?.({ id: "1", name: "read", arguments: { path: "README.md" } });
    sink.onCancelled?.();

    expect(chunks.join("")).toContain("[status:sandbox] clean");
    expect(chunks.join("")).toContain("hello");
    expect(chunks.join("")).toContain("> read");
    expect(chunks.join("")).toContain("(cancelled)");
  });

  it("streams thinking then prints collapse marker before answer text", () => {
    const chunks: string[] = [];
    const sink = createStdoutSessionUiSink((chunk) => chunks.push(chunk));
    sink.onThinkingDelta?.("step ");
    sink.onThinkingDelta?.("two");
    sink.onAssistantDelta?.("done");
    const out = chunks.join("");
    expect(out).toContain("[think] step two");
    expect(out).toContain("[think collapsed]");
    expect(out).toContain("done");
  });

  it("prints tool result preview on tool-end", () => {
    const chunks: string[] = [];
    const sink = createStdoutSessionUiSink((chunk) => chunks.push(chunk));
    sink.onToolStart?.({ id: "1", name: "bash", arguments: { command: "ls -la" } });
    sink.onToolEnd?.({ id: "1", name: "bash", arguments: { command: "ls -la" } }, {
      content: [{ type: "text", text: "a\nb\nc" }],
    });
    const out = chunks.join("");
    expect(out).toContain("> bash(ls -la)");
    expect(out).toContain("bash done");
    expect(out).toContain("a\nb\nc");
  });

  it("prints explicit context compaction lifecycle output", () => {
    const chunks: string[] = [];
    const sink = createStdoutSessionUiSink((chunk) => chunks.push(chunk));
    sink.onContextCompaction?.({ stage: "start", mode: "manual", before: 40 });
    sink.onContextCompaction?.({
      stage: "success",
      mode: "manual",
      before: 40,
      after: 12,
      usage: { inputTokens: 10, outputTokens: 2, cacheTokens: 0, reasoningTokens: 0 },
    });
    const out = chunks.join("");
    expect(out).toContain("[context] compacting...");
    expect(out).toContain("[context] compacted 40 -> 12 messages");
  });
});

describe("createStdoutSubagentUiBridge", () => {
  it("prefixes nested subagent output distinctly from primary agent", () => {
    const chunks: string[] = [];
    const bridge = createStdoutSubagentUiBridge((chunk) => chunks.push(chunk));
    const sink = bridge.forWorker({
      workerId: 2,
      modelLabel: "stub/flash",
      role: "locator",
      goal: "find auth entrypoints",
    });
    sink.onLifecycle?.("start", {
      workerId: 2,
      modelLabel: "stub/flash",
      role: "locator",
      goal: "find auth entrypoints",
    });
    sink.onThinkingDelta?.("trace ");
    sink.onAssistantDelta?.("done");
    sink.onToolStart?.({ id: "w2:1", name: "read", arguments: { path: "src/auth.ts" } });
    sink.onToolEnd?.({ id: "w2:1", name: "read", arguments: { path: "src/auth.ts" } }, {
      content: [{ type: "text", text: "export {}" }],
    });
    sink.onLifecycle?.("end", {
      workerId: 2,
      modelLabel: "stub/flash",
      goal: "find auth entrypoints",
      success: true,
      status: "success",
    });
    const out = chunks.join("");
    expect(out).toContain("⊹ subagent #2");
    expect(out).toContain("[think] trace");
    expect(out).toContain("> read");
    expect(out).toContain("read done");
    expect(out).not.toContain("●");
  });
});

describe("tool transcript helpers", () => {
  it("prefers bash command in tool detail", () => {
    expect(toolCallDetail({
      id: "e1",
      name: "explore",
      arguments: { goal: "find auth entrypoints", focus_paths: ["src/auth"] },
    })).toContain("find auth entrypoints");
    expect(toolCallDetail({ id: "1", name: "bash", arguments: { command: "echo hi", description: "x" } }))
      .toBe("echo hi");
  });

  it("joins tool result content parts", () => {
    expect(toolResultOutput({
      content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
    })).toBe("ab");
  });

  it("previews long tool output", () => {
    const text = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n");
    const preview = previewText(text, 8);
    expect(preview.truncated).toBe(true);
    expect(preview.text.split("\n")).toHaveLength(9);
    expect(preview.text).toContain("4 more lines");
  });
});

describe("formatUsageStatus", () => {
  it("scales token counts and marks cost as an estimate", () => {
    expect(formatUsageStatus(950)).toBe("tok:950 ~$0.00");
    expect(formatUsageStatus(12_345)).toBe("tok:12.3k ~$0.01");
    expect(formatUsageStatus(2_500_000)).toBe("tok:2.5M ~$2.50");
  });
});
