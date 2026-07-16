import { describe, expect, it } from "vitest";

import { TuiSessionBridge, type TuiEvent } from "./session-bridge.ts";

describe("TuiSessionBridge", () => {
  it("resolves an interactive confirmation with explicit action detail (not last notice)", async () => {
    const bridge = new TuiSessionBridge();
    const events: unknown[] = [];
    bridge.subscribe((event) => events.push(event));
    // Unrelated notice must not leak into the confirmation detail.
    bridge.sink.notify?.("workspace: /tmp (main tree)");

    const answer = bridge.ask("Merge changes?", "diff --git a/a.ts b/a.ts");
    expect(bridge.confirmPending).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "confirm-open",
      question: "Merge changes?",
      detail: "diff --git a/a.ts b/a.ts",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: "confirm-open",
      detail: "workspace: /tmp (main tree)",
    }));
    bridge.answerConfirmation(false);

    await expect(answer).resolves.toBe(false);
    expect(bridge.confirmPending).toBe(false);
  });

  it("buffers events emitted before the first subscriber and flushes once", () => {
    const bridge = new TuiSessionBridge();
    bridge.sink.notify?.("workspace: /repo (main tree)");
    bridge.sink.setStatus?.("workspace", "DIRECT / NO MERGEGATE");
    expect(bridge.preSubscriptionBufferLength).toBe(2);

    const events: TuiEvent[] = [];
    bridge.subscribe((event) => events.push(event));
    expect(events.some((e) => e.kind === "notice" && e.text.includes("workspace:"))).toBe(true);
    expect(events).toContainEqual({
      kind: "status",
      key: "workspace",
      text: "DIRECT / NO MERGEGATE",
    });
    expect(bridge.preSubscriptionBufferLength).toBe(0);

    // Second subscriber does not re-receive the startup buffer.
    const late: TuiEvent[] = [];
    bridge.subscribe((event) => late.push(event));
    bridge.sink.notify?.("later");
    expect(late.some((e) => e.kind === "notice" && e.text === "later")).toBe(true);
    expect(late.some((e) => e.kind === "status" && e.key === "workspace")).toBe(false);
  });

  it("supports select and secret prompt without echoing the secret into notices", async () => {
    const bridge = new TuiSessionBridge();
    const events: TuiEvent[] = [];
    bridge.subscribe((event) => events.push(event));

    const selectPromise = bridge.select("Pick", [
      { label: "DeepSeek", value: "deepseek" },
      { label: "OpenAI", value: "openai" },
    ]);
    expect(bridge.selectPending).toBe(true);
    bridge.answerSelect("deepseek");
    await expect(selectPromise).resolves.toBe("deepseek");

    const promptPromise = bridge.prompt("API key", { secret: true });
    expect(bridge.promptPending).toBe(true);
    expect(events.some((event) => event.kind === "prompt-open" && event.secret === true)).toBe(true);
    bridge.answerPrompt("sk-should-not-appear-in-transcript");
    await expect(promptPromise).resolves.toBe("sk-should-not-appear-in-transcript");
    expect(events.filter((event) => event.kind === "notice")).toHaveLength(0);
  });

  it("keeps bypass session-local and audits auto-approval", async () => {
    const bridge = new TuiSessionBridge();
    const notices: string[] = [];
    bridge.subscribe((event) => {
      if (event.kind === "notice") notices.push(event.text);
    });

    expect(bridge.bypass).toBe(false);
    expect(bridge.toggleBypass()).toBe(true);
    await expect(bridge.ask("Merge changes?")).resolves.toBe(true);
    expect(notices.join("\n")).toContain("Bypass enabled");
    expect(notices.join("\n")).toContain("Bypass auto-approved");
    expect(bridge.toggleBypass()).toBe(false);
    const confirmation = bridge.ask("Merge after disable?");
    expect(bridge.confirmPending).toBe(true);
    bridge.answerConfirmation(false);
    await expect(confirmation).resolves.toBe(false);
    expect(new TuiSessionBridge().bypass).toBe(false);
  });

  it("emits thinking-delta and tool-end output from the sink", () => {
    const bridge = new TuiSessionBridge();
    const events: TuiEvent[] = [];
    bridge.subscribe((event) => events.push(event));

    bridge.sink.onThinkingDelta?.("reason");
    bridge.sink.onToolStart?.({ id: "1", name: "bash", arguments: { command: "pwd" } });
    bridge.sink.onToolEnd?.({ id: "1", name: "bash", arguments: { command: "pwd" } }, {
      content: [{ type: "text", text: "/tmp" }],
      isError: false,
    });

    expect(events).toContainEqual({ kind: "thinking-delta", text: "reason" });
    expect(events).toContainEqual({ kind: "tool-start", name: "bash", detail: "pwd", callId: "1" });
    expect(events).toContainEqual({
      kind: "tool-end",
      name: "bash",
      error: false,
      output: "/tmp",
      callId: "1",
    });
  });

  it("forwards typed context compaction lifecycle events without parsing notices", () => {
    const bridge = new TuiSessionBridge();
    const events: TuiEvent[] = [];
    bridge.subscribe((event) => events.push(event));
    bridge.sink.onContextCompaction?.({ stage: "start", mode: "automatic", before: 80 });
    bridge.sink.onContextCompaction?.({
      stage: "success",
      mode: "automatic",
      before: 80,
      after: 20,
      usage: { inputTokens: 10, outputTokens: 2, cacheTokens: 0, reasoningTokens: 0 },
    });

    expect(events).toContainEqual({
      kind: "context-compaction",
      event: { stage: "start", mode: "automatic", before: 80 },
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: "context-compaction",
      event: expect.objectContaining({ stage: "success", before: 80, after: 20 }),
    }));
  });

  it("emits scoped subagent events via createSubagentUiBridge", () => {
    const bridge = new TuiSessionBridge();
    const events: TuiEvent[] = [];
    bridge.subscribe((event) => events.push(event));
    const subagent = bridge.createSubagentUiBridge().forWorker({
      workerId: 3,
      modelLabel: "stub/flash",
      role: "locator",
      goal: "map routes",
    });
    subagent.onLifecycle?.("start", {
      workerId: 3,
      modelLabel: "stub/flash",
      role: "locator",
      goal: "map routes",
    });
    subagent.onThinkingDelta?.("hmm");
    subagent.onToolStart?.({ id: "w3:1", name: "grep", arguments: { pattern: "route" } });
    subagent.onLifecycle?.("end", {
      workerId: 3,
      modelLabel: "stub/flash",
      goal: "map routes",
      success: true,
      status: "success",
    });

    expect(events).toContainEqual({
      kind: "subagent-start",
      workerId: 3,
      model: "stub/flash",
      role: "locator",
      goal: "map routes",
    });
    expect(events).toContainEqual({ kind: "subagent-thinking-delta", workerId: 3, text: "hmm" });
    expect(events).toContainEqual({
      kind: "subagent-tool-start",
      workerId: 3,
      name: "grep",
      detail: expect.any(String),
      callId: "w3:1",
    });
    expect(events).toContainEqual({
      kind: "subagent-end",
      workerId: 3,
      success: true,
      status: "success",
    });
    expect(events.some((event) => event.kind === "assistant-delta")).toBe(false);
  });
});
