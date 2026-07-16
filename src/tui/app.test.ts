import React from "react";
import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { ExtensionHost } from "../runtime/extension-host.ts";
import { CONTEXT_SUMMARY_NAME } from "../runtime/context-compaction.ts";
import { SESSION_RECOVERY_NAME } from "../runtime/session-recovery.ts";
import {
  App,
  collectSlashCommands,
  filterSlashCommands,
  formatToolOutputBody,
  estimateTranscriptEntryLines,
  isExploreTool,
  reduceEvent,
  slashQuery,
  sliceTranscriptWindow,
  thoughtLabel,
  toggleLatestExpandable,
  type ViewState,
} from "./app.ts";
import { TuiSessionBridge } from "./session-bridge.ts";
import { theme, truncateToolDetail } from "./theme.ts";

import { WorkspacePerceptionService } from "../runtime/workspace/index.ts";

import type { PreparedSession } from "../runtime/session.ts";
import type { ChatMessage } from "../runtime/types.ts";

function stubWorkspacePerception(): WorkspacePerceptionService {
  return new WorkspacePerceptionService({
    root: "/tmp",
    gitnexus: {
      name: "gitnexus",
      isAvailable: async () => false,
      queryStructure: async () => ({ kind: "unavailable", reason: "test" }),
    },
  });
}

describe("App", () => {
  afterEach(() => cleanup());

  it("renders header context and a slim hint footer without duplicating model/path", () => {
    const session: PreparedSession = {
      host: new ExtensionHost(),
      model: { provider: "test", id: "model-a" },
      getModel: () => ({ provider: "test", id: "model-a" }),
      setModel: async () => {},
      getThinkingLevel: () => "off",
      cycleThinkingLevel: async () => "off",
      getPermissionMode: () => "auto",
      cyclePermissionMode: () => "full",
      compact: async () => emptyCompaction(),
      runPrompt: async () => ({
        text: "",
        success: true,
        turns: 0,
        toolCalls: 0,
        toolErrors: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0 },
      }),
      abortTurn() {},
      steer() {},
      getMessages: () => [],
      workspacePerception: stubWorkspacePerception(),
      async close() {},
    };

    const output = renderToString(React.createElement(App, {
      session,
      bridge: new TuiSessionBridge(),
      cwd: "/tmp/project",
      async onExit() {},
    }), { columns: 80 });

    expect(output).toContain("XioCode v");
    expect(output).toContain("test/model-a");
    expect(output).toContain("think:off");
    expect(output).toContain("perm:auto");
    expect(output).toContain("/tmp/project");
    expect(output).toContain("Shift+Tab");
    expect(output).toMatch(/PgUp|滚动/);
    expect(output).toContain(">");
    expect(output).not.toContain("idle");
    expect(output).not.toMatch(/\|\s*think:off\s*\|/);
    // Footer must not re-pipe the full status chrome (model · think · path).
    const footerHintIndex = output.lastIndexOf("Shift+Tab 权限");
    const headerContext = output.slice(0, footerHintIndex);
    expect(headerContext).toContain("test/model-a · think:off · perm:auto · /tmp/project");
  });

  it("executes pasted slash input and renders the command result", async () => {
    const host = new ExtensionHost();
    host.registerCommand("status", { handler: () => "status-ok" });
    const session = createSession(host);
    const instance = render(React.createElement(App, {
      session,
      bridge: new TuiSessionBridge(),
      cwd: "/tmp/project",
      async onExit() {},
    }));

    instance.stdin.write("/status\r");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(instance.lastFrame()).toContain("/status");
    expect(instance.lastFrame()).toContain("status-ok");
  });

  it("renders diff confirmation and returns the selected answer", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));

    const answer = bridge.ask("Merge changes?", "diff --git a/a.ts b/a.ts\n-old\n+new");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).toContain("Merge changes?");
    expect(instance.lastFrame()).toContain("+new");
    instance.stdin.write("n");

    await expect(answer).resolves.toBe(false);
  });

  it("shows a scroll indicator when confirm detail exceeds the viewport", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));
    const longDiff = Array.from({ length: 80 }, (_, index) => `+line-${index}`).join("\n");

    const answer = bridge.ask("Merge long diff?", longDiff);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Merge long diff?");
    expect(frame).toMatch(/lines 1–\d+\/80/);
    instance.stdin.write("n");
    await expect(answer).resolves.toBe(false);
  });

  it("renders select modal and returns the choice on Enter", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));

    const answer = bridge.select("Pick a model", [
      { label: "fast · cheap", value: "fast" },
      { label: "smart · slow", value: "smart" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Pick a model");
    expect(frame).toContain("fast · cheap");
    expect(frame).toContain("›");
    expect(frame).not.toMatch(/\x1b\[7m/); // no full-row inverse selection
    instance.stdin.write("\r");
    await expect(answer).resolves.toBe("fast");
  });

  it("toggles session bypass from the slash command", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));

    instance.stdin.write("/bypass\r");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(bridge.bypass).toBe(true);
    expect(instance.lastFrame()).toContain("bypass on");
  });

  it("masks secret prompt input and does not append the secret to the transcript", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));

    const promptPromise = bridge.prompt("API key", { secret: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("sk-should-stay-masked");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("API key");
    expect(frame).toContain("*********************");
    expect(frame).not.toContain("sk-should-stay-masked");
    instance.stdin.write("\r");
    await expect(promptPromise).resolves.toBe("sk-should-stay-masked");
    expect(instance.lastFrame() ?? "").not.toContain("sk-should-stay-masked");
  });

  it("renders restored user and assistant transcript messages", () => {
    const session = createSession(new ExtensionHost(), [
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
    ]);
    const output = renderToString(React.createElement(App, {
      session,
      bridge: new TuiSessionBridge(),
      cwd: "/tmp/project",
      async onExit() {},
    }), { columns: 80 });

    expect(output).toContain("previous question");
    expect(output).toContain("previous answer");
  });

  it("renders a resumed context summary as a weak transcript notice", () => {
    const session = createSession(new ExtensionHost(), [
      { role: "system", content: "system" },
      { role: "system", name: CONTEXT_SUMMARY_NAME, content: "[context summary]\nprivate summary" },
      { role: "user", content: "continue" },
    ]);
    const output = renderToString(React.createElement(App, {
      session,
      bridge: new TuiSessionBridge(),
      cwd: "/tmp/project",
      async onExit() {},
    }), { columns: 80 });

    expect(output).toContain("Earlier context was compacted.");
    expect(output).not.toContain("private summary");
  });

  it("renders recovered execution state without exposing a separate modal", () => {
    const session = createSession(new ExtensionHost(), [
      { role: "system", content: "system" },
      {
        role: "system",
        name: SESSION_RECOVERY_NAME,
        content: "Recovered interrupted session state. 1 tool call(s) had unknown completion.",
      },
    ]);
    const output = renderToString(React.createElement(App, {
      session,
      bridge: new TuiSessionBridge(),
      cwd: "/tmp/project",
      async onExit() {},
    }), { columns: 80 });

    expect(output).toContain("Recovered interrupted session state.");
    expect(output).not.toContain("Confirm");
  });

  it("shows compaction progress only in the header and appends a success notice", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));
    bridge.sink.onContextCompaction?.({ stage: "start", mode: "automatic", before: 80 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).toContain("think:off · perm:auto · compacting... · /tmp/project");
    expect(instance.lastFrame()).toContain("Shift+Tab");

    bridge.sink.onContextCompaction?.({
      stage: "success",
      mode: "automatic",
      before: 80,
      after: 20,
      usage: { inputTokens: 1, outputTokens: 1, cacheTokens: 0, reasoningTokens: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).not.toContain("compacting...");
    expect(instance.lastFrame()).toContain("Context compacted: 80 -> 20 messages.");
  });

  it("renders context compaction failure as an error notice", () => {
    const state = reduceEvent(emptyView(), {
      kind: "context-compaction",
      event: { stage: "failure", mode: "manual", before: 20, error: "provider unavailable" },
    });
    expect(state.entries.at(-1)).toMatchObject({
      kind: "notice",
      error: true,
      text: "Context compaction failed: provider unavailable",
    });
  });

  it("streams thinking expanded then auto-collapses on first assistant delta", () => {
    let state: ViewState = emptyView();
    state = reduceEvent(state, { kind: "thinking-delta", text: "consider options" });
    expect(state.entries.at(-1)).toMatchObject({ kind: "thinking", text: "consider options", collapsed: false });
    state = reduceEvent(state, { kind: "assistant-delta", text: "final" });
    expect(state.entries.find((entry) => entry.kind === "thinking")).toMatchObject({
      collapsed: true,
      thoughtSeconds: expect.any(Number),
    });
    expect(state.entries.at(-1)).toMatchObject({ kind: "assistant", text: "final" });
  });

  it("collapses open thinking when a tool starts (avoids Thought/⚙ line merge)", () => {
    let state: ViewState = emptyView();
    state = reduceEvent(state, { kind: "thinking-delta", text: "plan next step" });
    expect(state.entries.at(-1)).toMatchObject({ kind: "thinking", collapsed: false });
    state = reduceEvent(state, { kind: "tool-start", name: "bash", detail: "pwd", callId: "t1" });
    const thinking = state.entries.find((entry) => entry.kind === "thinking");
    expect(thinking).toMatchObject({ collapsed: true, thoughtSeconds: expect.any(Number) });
    expect(state.entries.at(-1)).toMatchObject({ kind: "tool", title: "bash", detail: "pwd" });
  });

  it("labels think rows and empty tool output for layered display", () => {
    expect(thoughtLabel({ collapsed: false })).toBe("thinking…");
    expect(thoughtLabel({ collapsed: true, thoughtSeconds: 8 })).toBe("think 8s");
    expect(isExploreTool("explore")).toBe(true);
    expect(isExploreTool("bash")).toBe(false);
    expect(formatToolOutputBody("", true, true)).toEqual([`  ${theme.sym.nest} (empty)`]);
    expect(formatToolOutputBody("hi", true, true)[0]).toContain("hi");
    expect(truncateToolDetail("a".repeat(100)).endsWith("…")).toBe(true);
  });

  it("slices transcript window for scroll (offset 0 = latest, unit heights)", () => {
    const entries = Array.from({ length: 20 }, (_, i) => i);
    const bottom = sliceTranscriptWindow(entries, 5, 0);
    expect(bottom.visible).toEqual([15, 16, 17, 18, 19]);
    expect(bottom.hiddenAbove).toBe(15);
    expect(bottom.hiddenBelow).toBe(0);
    expect(bottom.maxOffset).toBe(15);

    const up = sliceTranscriptWindow(entries, 5, 3);
    expect(up.visible).toEqual([12, 13, 14, 15, 16]);
    expect(up.hiddenAbove).toBe(12);
    expect(up.hiddenBelow).toBe(3);

    const top = sliceTranscriptWindow(entries, 5, 10_000);
    expect(top.offset).toBe(15);
    expect(top.visible).toEqual([0, 1, 2, 3, 4]);
    expect(top.hiddenAbove).toBe(0);
  });

  it("line-based window: few tall tools still allow scroll (maxOffset > 0)", () => {
    // Three tools each ~10 rows; viewport 12 → cannot show all; must scroll.
    const entries = [
      { id: 1, kind: "tool" as const, text: "done", title: "read", output: "a\n".repeat(12) },
      { id: 2, kind: "tool" as const, text: "done", title: "glob", output: "b\n".repeat(12) },
      { id: 3, kind: "tool" as const, text: "done", title: "bash", output: "c\n".repeat(12) },
    ];
    const height = (entry: (typeof entries)[number]) => estimateTranscriptEntryLines(entry, 80);
    const total = entries.reduce((sum, e) => sum + height(e), 0);
    expect(total).toBeGreaterThan(12);

    const bottom = sliceTranscriptWindow(entries, 12, 0, height);
    expect(bottom.maxOffset).toBeGreaterThan(0);
    expect(bottom.hiddenBelow).toBe(0);
    // Bottom window should include the last tool.
    expect(bottom.visible.some((e) => e.id === 3)).toBe(true);

    const up = sliceTranscriptWindow(entries, 12, Math.min(15, bottom.maxOffset), height);
    expect(up.offset).toBeGreaterThan(0);
    expect(up.hiddenBelow).toBe(up.offset);
    // Scrolling up should reveal older tools.
    expect(up.visible.some((e) => e.id === 1 || e.id === 2)).toBe(true);
  });

  it("estimates multi-line tool rows taller than a single entry", () => {
    const short = estimateTranscriptEntryLines({
      id: 1, kind: "notice", text: "hi",
    }, 80);
    const tall = estimateTranscriptEntryLines({
      id: 2,
      kind: "tool",
      text: "done",
      title: "read",
      output: Array.from({ length: 20 }, (_, i) => `${i}|line`).join("\n"),
      previewCollapsed: true,
    }, 80);
    expect(short).toBe(1);
    expect(tall).toBeGreaterThan(short + 5);
  });

  it("renders think Ns and bullet assistant in the tree", () => {
    let state: ViewState = emptyView();
    state = reduceEvent(state, { kind: "thinking-delta", text: "plan" });
    state = {
      ...state,
      entries: state.entries.map((entry) =>
        entry.kind === "thinking"
          ? { ...entry, collapsed: true, thoughtSeconds: 8 }
          : entry
      ),
    };
    state = reduceEvent(state, { kind: "assistant-delta", text: "你好" });
    const thinking = state.entries.find((entry) => entry.kind === "thinking");
    expect(thinking).toMatchObject({ collapsed: true, thoughtSeconds: 8 });
    expect(thoughtLabel(thinking!)).toBe("think 8s");
    expect(state.entries.at(-1)).toMatchObject({ kind: "assistant", text: "你好" });
  });

  it("manually re-expands collapsed thinking via toggleLatestExpandable", () => {
    let state: ViewState = emptyView();
    state = reduceEvent(state, { kind: "thinking-delta", text: "plan" });
    state = reduceEvent(state, { kind: "assistant-delta", text: "answer" });
    expect(state.entries.find((entry) => entry.kind === "thinking")).toMatchObject({ collapsed: true });
    state = toggleLatestExpandable(state);
    expect(state.entries.find((entry) => entry.kind === "thinking")).toMatchObject({ collapsed: false });
  });

  it("keeps tool output as preview when longer than eight lines", () => {
    let state: ViewState = emptyView();
    state = reduceEvent(state, { kind: "tool-start", name: "bash", detail: "seq 1 12", callId: "c1" });
    const output = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n");
    state = reduceEvent(state, {
      kind: "tool-end",
      name: "bash",
      error: false,
      output,
      callId: "c1",
    });
    const tool = state.entries.find((entry) => entry.kind === "tool");
    expect(tool).toMatchObject({
      title: "bash",
      detail: "seq 1 12",
      text: "done",
      output,
      previewCollapsed: true,
      callId: "c1",
    });
  });

  it("pairs parallel same-name tools by callId", () => {
    let state: ViewState = emptyView();
    state = reduceEvent(state, { kind: "tool-start", name: "read", detail: "a.ts", callId: "r1" });
    state = reduceEvent(state, { kind: "tool-start", name: "read", detail: "b.ts", callId: "r2" });
    // Finish second first (out of order) — must not attach to first start.
    state = reduceEvent(state, {
      kind: "tool-end",
      name: "read",
      error: false,
      output: "body-b",
      callId: "r2",
    });
    state = reduceEvent(state, {
      kind: "tool-end",
      name: "read",
      error: false,
      output: "body-a",
      callId: "r1",
    });
    const tools = state.entries.filter((entry) => entry.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ callId: "r1", detail: "a.ts", output: "body-a" });
    expect(tools[1]).toMatchObject({ callId: "r2", detail: "b.ts", output: "body-b" });
  });

  it("expands long tool output and skips short tools when toggling", () => {
    let state: ViewState = emptyView();
    state = reduceEvent(state, { kind: "thinking-delta", text: "reason" });
    state = reduceEvent(state, { kind: "assistant-delta", text: "ok" });
    state = reduceEvent(state, { kind: "tool-start", name: "bash", detail: "echo hi" });
    state = reduceEvent(state, { kind: "tool-end", name: "bash", error: false, output: "hi" });
    // Short tool must not swallow Ctrl+O — re-expand collapsed thinking.
    state = toggleLatestExpandable(state);
    expect(state.entries.find((entry) => entry.kind === "thinking")).toMatchObject({ collapsed: false });

    const long = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n");
    state = reduceEvent(state, { kind: "tool-start", name: "bash", detail: "seq" });
    state = reduceEvent(state, { kind: "tool-end", name: "bash", error: true, output: long });
    const failed = state.entries.at(-1);
    expect(failed).toMatchObject({ kind: "tool", text: "failed", error: true, previewCollapsed: true, output: long });
    state = toggleLatestExpandable(state);
    expect(state.entries.at(-1)).toMatchObject({ previewCollapsed: false });
  });

  it("filters slash commands by prefix and hides menu after a space", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/ef")).toBe("ef");
    expect(slashQuery("/effort high")).toBeUndefined();
    const host = new ExtensionHost();
    host.registerCommand("effort", { description: "Set effort.", handler: async () => {} });
    host.registerCommand("model", { description: "Switch model.", handler: async () => {} });
    host.registerCommand("compact", { description: "Compact context.", handler: async () => {} });
    const all = collectSlashCommands(host);
    expect(all.map((item) => item.name)).toEqual(expect.arrayContaining(["bypass", "compact", "effort", "help", "model"]));
    expect(all.filter((item) => item.name === "compact")).toHaveLength(1);
    expect(filterSlashCommands(all, "ef")?.map((item) => item.name)).toEqual(["effort"]);
    expect(filterSlashCommands(all, undefined)).toBeUndefined();
  });

  it("shows slash command menu when typing /", async () => {
    const host = new ExtensionHost();
    host.registerCommand("effort", { description: "Set thinking effort.", handler: async () => "ok" });
    const instance = render(React.createElement(App, {
      session: createSession(host),
      bridge: new TuiSessionBridge(),
      cwd: "/tmp/project",
      async onExit() {},
    }));
    instance.stdin.write("/");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("effort");
    expect(frame).toContain("help");
    expect(frame).toContain("Set thinking effort.");
    expect(frame).toMatch(/\d+\/\d+/);
  });

  it("busy Enter soft-steers and ! hard-steers via session.steer (not queue-only)", async () => {
    const host = new ExtensionHost();
    const steers: Array<{ text: string; mode?: string }> = [];
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const session: PreparedSession = {
      ...createSession(host),
      steer(text, mode) {
        steers.push({ text, mode });
      },
      runPrompt: async () => {
        await promptGate;
        return {
          text: "done",
          success: true,
          turns: 1,
          toolCalls: 0,
          toolErrors: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0 },
        };
      },
    };

    const instance = render(React.createElement(App, {
      session,
      bridge: new TuiSessionBridge(),
      cwd: "/tmp/project",
      async onExit() {},
    }));

    instance.stdin.write("first turn");
    instance.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 40));

    instance.stdin.write("soft redirect");
    instance.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(steers).toEqual([{ text: "soft redirect", mode: "soft" }]);

    instance.stdin.write("!hard redirect");
    instance.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(steers).toEqual([
      { text: "soft redirect", mode: "soft" },
      { text: "hard redirect", mode: "hard" },
    ]);

    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toMatch(/\[queued:/);

    releasePrompt();
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
});

function emptyView(): ViewState {
  return { entries: [] as ViewState["entries"], statuses: {}, widgets: {}, bypass: false };
}

function createSession(host: ExtensionHost, messages: readonly ChatMessage[] = []): PreparedSession {
  const model = { provider: "test", id: "model-a" };
  let permission: "strict" | "auto" | "full" = "auto";
  return {
    host,
    model,
    getModel: () => model,
    setModel: async () => {},
    getThinkingLevel: () => host.getThinkingLevel(),
    cycleThinkingLevel: async () => {
      const next = host.getThinkingLevel() === "off" ? "high" : "off";
      host.setThinkingLevel(next);
      return next;
    },
    getPermissionMode: () => permission,
    cyclePermissionMode: () => {
      permission = permission === "auto" ? "full" : permission === "full" ? "strict" : "auto";
      return permission;
    },
    compact: async () => emptyCompaction(),
    runPrompt: async () => ({
      text: "",
      success: true,
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0 },
    }),
    abortTurn() {},
    steer() {},
    getMessages: () => messages,
    workspacePerception: stubWorkspacePerception(),
    async close() {},
  };
}

function emptyCompaction() {
  return {
    compacted: false,
    before: 0,
    after: 0,
    messages: [] as readonly ChatMessage[],
    usage: { inputTokens: null, outputTokens: null, cacheTokens: null, reasoningTokens: null },
  } as const;
}
