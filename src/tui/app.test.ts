import React from "react";
import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { ExtensionHost } from "../runtime/extension-host.ts";
import { CONTEXT_SUMMARY_NAME } from "../runtime/context-compaction.ts";
import { SESSION_RECOVERY_NAME } from "../runtime/session-recovery.ts";
import {
  App,
  busyPhaseLabel,
  collectSlashCommands,
  composePhaseChrome,
  filterSlashCommands,
  formatExploreFooter,
  formatMcpFooter,
  formatToolOutputBody,
  formatWorkspaceFooter,
  estimateTranscriptEntryLines,
  isDefaultPermissionMode,
  isExploreTool,
  livePreviewCharBudget,
  reduceEvent,
  slashQuery,
  sliceTranscriptWindow,
  thoughtLabel,
  toggleLatestExpandable,
  viewerScrollBounds,
  VIEWER_CHROME_ROWS,
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

describe("busyPhaseLabel", () => {
  it("prefixes the phase with the spinner frame only when both exist", () => {
    expect(composePhaseChrome("working…", "⠋")).toBe("⠋ working…");
    expect(composePhaseChrome("working…", undefined)).toBe("working…");
    expect(composePhaseChrome(undefined, "⠋")).toBeUndefined();
  });

  it("maps requesting → streaming → tools chrome", () => {
    expect(busyPhaseLabel({ busy: false, inFlightToolCount: 0 })).toBeUndefined();
    expect(busyPhaseLabel({ busy: true, inFlightToolCount: 0 })).toBe("working…");
    expect(busyPhaseLabel({ busy: true, inFlightToolCount: 0, liveKind: "assistant" })).toBe("streaming…");
    expect(busyPhaseLabel({ busy: true, inFlightToolCount: 0, liveKind: "thinking" })).toBe("streaming…");
    expect(busyPhaseLabel({
      busy: true,
      inFlightToolCount: 1,
      inFlightSubagentCount: 2,
    })).toBe("agents…");
    expect(busyPhaseLabel({
      busy: true,
      inFlightToolCount: 2,
      liveKind: "assistant",
    })).toBe("tools…");
  });
});

describe("Claude-quiet footer helpers", () => {
  it("treats auto as the quiet default permission mode", () => {
    expect(isDefaultPermissionMode("auto")).toBe(true);
    expect(isDefaultPermissionMode("full")).toBe(false);
    expect(isDefaultPermissionMode("strict")).toBe(false);
  });

  it("formats explore / workspace / mcp for the footer right side", () => {
    expect(formatExploreFooter("subs:1")).toBe("← 1 agent");
    expect(formatExploreFooter("subs:3")).toBe("← 3 agents");
    expect(formatWorkspaceFooter("DIRECT / NO MERGEGATE")).toBe("direct");
    expect(formatWorkspaceFooter("WORKTREE")).toBe("worktree");
    expect(formatWorkspaceFooter("direct")).toBe("direct");
    expect(formatMcpFooter("mcp:ready(2)")).toBe("2 mcp");
    expect(formatMcpFooter("mcp:1ok/1fail")).toBe("mcp 1ok/1fail");
    expect(formatMcpFooter("mcp:connecting(3)")).toBe("mcp…");
  });
});

describe("App", () => {
  afterEach(() => cleanup());

  it("renders lean header and Claude-style footer with path", () => {
    const session: PreparedSession = {
      host: new ExtensionHost(),
      model: { provider: "test", id: "model-a" },
      getModel: () => ({ provider: "test", id: "model-a" }),
      setModel: async () => {},
      getThinkingLevel: () => "off",
      cycleThinkingLevel: async () => "off",
      getPermissionMode: () => "auto",
      setPermissionMode: (mode) => mode,
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
      followUp() {},
      getMessages: () => [],
      workspacePerception: stubWorkspacePerception(),
      async close() {},
      waitForIdle: async () => {},
      getHarnessPhase: () => "idle" as const,
    };

    const output = renderToString(React.createElement(App, {
      session,
      bridge: new TuiSessionBridge(),
      cwd: "/tmp/project",
      async onExit() {},
    }), { columns: 100 });

    expect(output).toContain("XioCode v");
    expect(output).toContain("test/model-a");
    expect(output).toContain("think:off");
    expect(output).toContain(">");
    expect(output).not.toContain("idle");
    expect(output).not.toMatch(/\|\s*think:off\s*\|/);
    // Header: model · think — no path / perm / usage dump.
    expect(output).toContain("test/model-a · think:off");
    expect(output).not.toContain("perm:auto · /tmp/project");
    // Footer: quiet default mode + cwd (Claude parity).
    expect(output).toContain("?");
    expect(output).toContain("for shortcuts");
    expect(output).toContain("/tmp/project");
    expect(output).not.toContain("permissions auto");
    expect(output).not.toMatch(/▸think|触控板|Shift\+Enter 换行|DIRECT \/ NO MERGEGATE/);
  });

  it("shows context occupancy status in the Claude-style footer", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));
    bridge.sink.setStatus?.("usage", "ctx:42%");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("? for shortcuts");
    expect(frame).toContain("/tmp/project");
    expect(frame).toContain("ctx:42%");
  });

  it("renders the buffered disconnected model status in the header", async () => {
    const bridge = new TuiSessionBridge();
    bridge.sink.setStatus?.("model", "not connected · /connect");
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));

    const frame = await waitForFrame(instance, (value) => value.includes("not connected · /connect"));
    expect(frame).toContain("not connected · /connect");
  });

  it("stays interactive after /connect cancellation and probe failure", async () => {
    const bridge = new TuiSessionBridge();
    const host = new ExtensionHost();
    let attempts = 0;
    host.registerCommand("connect", {
      handler: async () => {
        attempts += 1;
        if (attempts === 1) {
          const selected = await bridge.select("Select a provider", [
            { label: "DeepSeek", value: "deepseek" },
          ]);
          return selected ? "unexpected" : "connect cancelled";
        }
        throw new Error("API key validation failed (401)");
      },
    });
    host.registerCommand("status", { handler: () => "status-ok-after-connect-error" });
    const instance = render(React.createElement(App, {
      session: createSession(host),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));

    instance.stdin.write("/connect\r");
    await waitForFrame(instance, (frame) => frame.includes("Select a provider"));
    instance.stdin.write("\x1b");
    await waitForFrame(instance, (frame) => frame.includes("connect cancelled"));

    instance.stdin.write("/connect\r");
    await waitForFrame(instance, (frame) => frame.includes("validation failed (401)"));
    instance.stdin.write("/status\r");
    const recovered = await waitForFrame(
      instance,
      (frame) => frame.includes("status-ok-after-connect-error"),
    );
    expect(recovered).toContain("status-ok-after-connect-error");
  });

  it("folds completed thinking while retaining it in the transcript viewer", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));

    bridge.sink.onThinkingDelta?.("inspect private reasoning");
    bridge.sink.onAssistantText?.("final answer");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const collapsed = instance.lastFrame() ?? "";
    expect(collapsed).toMatch(/Thought for \d+s/);
    expect(collapsed).toContain("Ctrl+O");
    // Folded block keeps a one-line nested peek; full body stays in the viewer.
    expect(collapsed).toContain("└ inspect private reasoning");

    instance.stdin.write("\x0f");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const viewer = instance.lastFrame() ?? "";
    expect(viewer).toContain("Transcript · Thinking");
    expect(viewer).toContain("inspect private reasoning");
  });

  it("navigates retained thinking and tool transcripts without crossing history bounds", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));

    bridge.sink.onThinkingDelta?.("reasoning transcript");
    bridge.sink.onAssistantText?.("answer");
    const call = { id: "read-1", name: "read", arguments: { path: "src/main.ts" } };
    bridge.sink.onToolStart?.(call);
    bridge.sink.onToolEnd?.(call, {
      content: [{ type: "text", text: "tool transcript" }],
      isError: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    instance.stdin.write("\x0f");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(instance.lastFrame()).toContain("Transcript 2/2 · read");
    expect(instance.lastFrame()).toContain("tool transcript");

    instance.stdin.write("\x1b[D");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(instance.lastFrame()).toContain("Transcript 1/2 · Thinking");
    expect(instance.lastFrame()).toContain("reasoning transcript");

    instance.stdin.write("\x1b[D");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(instance.lastFrame()).toContain("Transcript 1/2 · Thinking");

    instance.stdin.write("\x1b[C");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(instance.lastFrame()).toContain("Transcript 2/2 · read");
  });

  it("shows compact subagent activity and opens the retained transcript", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));
    const subagent = bridge.createSubagentUiBridge().forWorker({
      workerId: 3,
      modelLabel: "stub/flash",
      role: "locator",
      goal: "map routes",
    });
    const meta = {
      workerId: 3,
      modelLabel: "stub/flash",
      role: "locator" as const,
      goal: "map routes",
    };

    subagent.onLifecycle?.("start", meta);
    subagent.onThinkingDelta?.("private reasoning");
    // Soft deltas flush on a 16ms coalescer timer; fixed sleeps go flaky under
    // parallel CI load, so poll the frame until the expected rows appear.
    const started = await waitForFrame(instance, (frame) =>
      frame.includes("subagent #3") && frame.includes("Thinking"));
    expect(started).toContain("subagent #3");
    expect(started).toContain("Thinking");
    expect(started).not.toContain("private reasoning");

    const call = { id: "w3:1", name: "grep", arguments: { pattern: "route" } };
    subagent.onToolStart?.(call);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(instance.lastFrame()).toContain("Running: grep");

    subagent.onToolEnd?.(call, {
      content: [{ type: "text", text: "route hit" }],
      isError: false,
    });
    subagent.onAssistantText?.("found the route");
    subagent.onLifecycle?.("end", { ...meta, success: true, status: "success" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const collapsed = instance.lastFrame() ?? "";
    expect(collapsed).toContain("success");
    expect(collapsed).toContain("found the route");
    expect(collapsed).toContain("Ctrl+O");
    expect(collapsed).not.toContain("private reasoning");
    expect(collapsed).not.toContain("route hit");

    instance.stdin.write("\x0f");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const viewer = instance.lastFrame() ?? "";
    expect(viewer).toContain("Transcript · subagent #3");
    expect(viewer).toContain("private reasoning");
    expect(viewer).toContain("route hit");
  });

  it("line-granular window shows the tail of a report taller than the viewport", async () => {
    // Regression: block-granular windowing hid a >viewport assistant report
    // entirely at offset 0 and overflowed on scroll ("一滑就消失").
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));
    const report = Array.from({ length: 200 }, (_, i) => `report line ${i + 1}`).join("\n");
    bridge.sink.onAssistantText?.(report);
    bridge.sink.notify?.("Done in 1s");
    await new Promise((resolve) => setTimeout(resolve, 60));

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Done in 1s");
    // Tail of the tall report stays visible at the bottom window.
    expect(frame).toContain("report line 200");

    // PgUp scrolls 20 lines up: the window now ends near report line 180
    // (201 total lines - 20), independent of the test terminal height.
    // (Top hint row can be garbled by ink-testing-library frame merging, so
    // assert on the bottom hint + stable content lines only.)
    instance.stdin.write("\x1b[5~");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const scrolled = instance.lastFrame() ?? "";
    expect(scrolled).toContain("lines to latest");
    expect(scrolled).toContain("report line 175");
    expect(scrolled).toContain("report line 180");
    expect(scrolled).not.toContain("report line 200");
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

  it("maps /bypass to permission full and shows the profile footer", async () => {
    const bridge = new TuiSessionBridge();
    const session = createSession(new ExtensionHost());
    const instance = render(React.createElement(App, {
      session,
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));

    instance.stdin.write("/bypass\r");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(session.getPermissionMode()).toBe("full");
    expect(instance.lastFrame()).toContain("permissions full on");
    expect(instance.lastFrame()).not.toContain("bypass permissions on");

    // Merge/rollback confirms are not short-circuited.
    const merge = bridge.ask("Merge changes?");
    expect(bridge.confirmPending).toBe(true);
    bridge.answerConfirmation(false);
    await expect(merge).resolves.toBe(false);
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

  it("shows compaction progress in the footer and appends a success notice", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));
    bridge.sink.onContextCompaction?.({ stage: "start", mode: "automatic", before: 80 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const compacting = instance.lastFrame() ?? "";
    expect(compacting).toContain("? for shortcuts");
    expect(compacting).toContain("/tmp/project");
    expect(compacting).toContain("compacting...");
    expect(compacting).not.toContain("think:off · perm:auto · compacting...");

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
    expect(thoughtLabel({ collapsed: false })).toBe("Thinking…");
    expect(thoughtLabel({ collapsed: true, thoughtSeconds: 8 })).toBe("Thought for 8s");
    expect(isExploreTool("explore")).toBe(true);
    expect(isExploreTool("bash")).toBe(false);
    expect(formatToolOutputBody("", true, true)).toEqual([`  ${theme.sym.nest} (empty)`]);
    expect(formatToolOutputBody("hi", true, true)).toEqual([]);
    expect(formatToolOutputBody("hi", false, true)[0]).toContain("hi");
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
    // Expanded tools each ~10 rows; viewport 12 → cannot show all; must scroll.
    const entries = [
      { id: 1, kind: "tool" as const, text: "done", title: "read", output: "a\n".repeat(12), previewCollapsed: false },
      { id: 2, kind: "tool" as const, text: "done", title: "glob", output: "b\n".repeat(12), previewCollapsed: false },
      { id: 3, kind: "tool" as const, text: "done", title: "bash", output: "c\n".repeat(12), previewCollapsed: false },
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

  it("estimates multi-line tool rows taller when expanded", () => {
    const short = estimateTranscriptEntryLines({
      id: 1, kind: "notice", text: "hi",
    }, 80);
    const collapsed = estimateTranscriptEntryLines({
      id: 2,
      kind: "tool",
      text: "done",
      title: "read",
      output: Array.from({ length: 20 }, (_, i) => `${i}|line`).join("\n"),
      previewCollapsed: true,
    }, 80);
    const tall = estimateTranscriptEntryLines({
      id: 3,
      kind: "tool",
      text: "done",
      title: "read",
      output: Array.from({ length: 20 }, (_, i) => `${i}|line`).join("\n"),
      previewCollapsed: false,
    }, 80);
    expect(short).toBe(1);
    expect(collapsed).toBeLessThanOrEqual(3);
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
    expect(thoughtLabel(thinking!)).toBe("Thought for 8s");
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

  it("toggles latest tool body via Ctrl+O (collapsed by default)", () => {
    let state: ViewState = emptyView();
    state = reduceEvent(state, { kind: "thinking-delta", text: "reason" });
    state = reduceEvent(state, { kind: "assistant-delta", text: "ok" });
    state = reduceEvent(state, { kind: "tool-start", name: "bash", detail: "echo hi" });
    state = reduceEvent(state, { kind: "tool-end", name: "bash", error: false, output: "hi" });
    expect(state.entries.at(-1)).toMatchObject({ kind: "tool", previewCollapsed: true });
    // Latest tool wins over older thinking.
    state = toggleLatestExpandable(state);
    expect(state.entries.at(-1)).toMatchObject({ kind: "tool", previewCollapsed: false });
    expect(state.entries.find((entry) => entry.kind === "thinking")).toMatchObject({ collapsed: true });

    const long = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n");
    state = reduceEvent(state, { kind: "tool-start", name: "bash", detail: "seq" });
    state = reduceEvent(state, { kind: "tool-end", name: "bash", error: true, output: long });
    const failed = state.entries.at(-1);
    expect(failed).toMatchObject({ kind: "tool", text: "failed", error: true, previewCollapsed: true, output: long });
    state = toggleLatestExpandable(state);
    expect(state.entries.at(-1)).toMatchObject({ previewCollapsed: false });
  });

  it("bounds Ctrl+O viewer scrolling to the retained output length", () => {
    // Regression: unclamped wheel/PgDn overshoot accrued invisible offset debt,
    // so scrolling back up after hitting the bottom felt dead (无法滑动).
    const block = {
      id: 1,
      kind: "tool" as const,
      lines: ["> bash"],
      output: Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n"),
    };
    // 24 terminal rows − chrome (header + overlay + composer + footer) → 6-line
    // viewport → last valid offset 40 - 6 = 34. Regression: rows-10 overflowed
    // the terminal and left residue after Esc closed the overlay.
    expect(viewerScrollBounds(block, 24)).toEqual({ viewport: 6, maxOffset: 34 });
    // Content shorter than the viewport never scrolls.
    expect(viewerScrollBounds({ ...block, output: "one\ntwo" }, 24).maxOffset).toBe(0);
    // Tiny terminals keep the 4-line viewport floor.
    expect(viewerScrollBounds(block, 10).viewport).toBe(4);
    // Viewer viewport + chrome must fit the terminal (no un-erasable overflow).
    for (const rows of [20, 24, 40, 60]) {
      expect(viewerScrollBounds(block, rows).viewport + VIEWER_CHROME_ROWS)
        .toBeLessThanOrEqual(Math.max(rows, 4 + VIEWER_CHROME_ROWS));
    }
  });

  it("caps the live preview char budget to a screen-bounded region", () => {
    // 24×80 terminal: 8 preview rows × 78 usable cols.
    expect(livePreviewCharBudget(24, 80)).toBe(8 * 78);
    // Tall terminals clamp at 12 rows so streams never crowd out the composer.
    expect(livePreviewCharBudget(200, 100)).toBe(12 * 98);
    // Tiny/unknown sizes keep a sane floor.
    expect(livePreviewCharBudget(6, 0)).toBe(3 * 78);
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
    const followUps: string[] = [];
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const session: PreparedSession = {
      ...createSession(host),
      steer(text, mode) {
        steers.push({ text, mode });
      },
      followUp(text) {
        followUps.push(text);
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

    instance.stdin.write(">>after this");
    instance.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(followUps).toEqual(["after this"]);
    expect(steers).toHaveLength(2);

    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toMatch(/\[queued:/);

    releasePrompt();
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
});

function emptyView(): ViewState {
  return { entries: [] as ViewState["entries"], statuses: {}, widgets: {} };
}

/**
 * Poll the rendered frame until `predicate` matches (or timeout). Fixed sleeps
 * are unreliable for soft-delta renders under parallel test load.
 */
async function waitForFrame(
  instance: ReturnType<typeof render>,
  predicate: (frame: string) => boolean,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = instance.lastFrame() ?? "";
  while (!predicate(frame) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    frame = instance.lastFrame() ?? "";
  }
  return frame;
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
    setPermissionMode: (mode) => {
      permission = mode;
      return permission;
    },
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
    followUp() {},
    getMessages: () => messages,
    workspacePerception: stubWorkspacePerception(),
    async close() {},
    waitForIdle: async () => {},
    getHarnessPhase: () => "idle" as const,
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
