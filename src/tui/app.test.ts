import React from "react";
import { renderToString, Text } from "ink";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { ExtensionHost } from "../runtime/extension-host.ts";
import { CONTEXT_SUMMARY_NAME } from "../runtime/context-compaction.ts";
import { SESSION_RECOVERY_NAME } from "../runtime/session-recovery.ts";
import {
  App,
  InputCandidateRegion,
  ComposerChrome,
  busyPhaseLabel,
  collectSlashCommands,
  composePhaseChrome,
  filterSlashCommands,
  formatExploreFooter,
  formatMcpFooter,
  formatWorkspaceFooter,
  isDefaultPermissionMode,
  livePreviewCharBudget,
  reduceEvent,
  slashQuery,
  viewerScrollBounds,
  VIEWER_CHROME_ROWS,
  type ViewState,
} from "./app.ts";
import { TuiSessionBridge } from "./session-bridge.ts";
import { emptyComposer, setComposerText } from "./composer.ts";
import { theme } from "./theme.ts";

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
      getCostSummary: () => ({ totalTokens: 0, costUsd: null, hasUnpriced: false }),
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
      rewind: { list: () => [], run: async () => ({ skipped: true, summary: "" }) },
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
    expect(output).toContain(theme.sym.prompt);
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

  it("opens the rewind picker on Esc Esc with an empty prompt and puts the prompt back", async () => {
    const calls: [number, string][] = [];
    const point = (index: number, prompt: string, code = true) => ({
      index,
      at: "",
      prompt,
      code: code ? { available: true as const } : { available: false as const, reason: "snapshot pruned" },
      conversation: { available: true as const },
    });
    const session: PreparedSession = {
      ...createSession(new ExtensionHost()),
      rewind: {
        list: () => [point(1, "add feature A", false), point(2, "refactor A")],
        run: async (index, mode) => {
          calls.push([index, mode]);
          return { skipped: false, summary: "rewound to turn 2", prompt: "refactor A" };
        },
      },
    };
    const instance = render(React.createElement(App, {
      session,
      bridge: new TuiSessionBridge(),
      cwd: "/tmp/project",
      async onExit() {},
    }));

    instance.stdin.write("\x1b");
    await waitForFrame(instance, (frame) => frame.includes("esc again to rewind"));
    instance.stdin.write("\x1b");
    const list = await waitForFrame(instance, (frame) => frame.includes("Rewind to the start of a turn"));
    // Newest first; the pruned point says what it can still restore.
    expect(list.indexOf("refactor A")).toBeLessThan(list.indexOf("add feature A"));
    expect(list).toContain("(chat)");

    instance.stdin.write("\x1b[B"); // older point: files unavailable
    await waitForFrame(instance, (frame) => /❯?\s*1\. add feature A/.test(frame));
    instance.stdin.write("\r");
    const options = await waitForFrame(instance, (frame) => frame.includes("Rewind to before: add feature A"));
    expect(options).toContain("Restore files only — snapshot pruned");
    instance.stdin.write("\x1b"); // back to the list
    await waitForFrame(instance, (frame) => frame.includes("Rewind to the start of a turn"));
    instance.stdin.write("\x1b[A");
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.stdin.write("\r");
    await waitForFrame(instance, (frame) => frame.includes("Rewind to before: refactor A"));
    instance.stdin.write("\r");

    const done = await waitForFrame(instance, (frame) => frame.includes("rewound to turn 2"));
    expect(calls).toEqual([[2, "both"]]);
    expect(done).toContain("refactor A");
    expect(done).not.toContain("Rewind to the start of a turn");
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
    expect(collapsed).toContain("ctrl+o");
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
    expect(collapsed).toContain("ctrl+o");
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

  it("keeps long/CJK select rows on one truncated line", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));
    // Ink counts CJK as a single column while terminals render two, so an
    // unclipped label used to fold into a second row, push the frame past the
    // terminal height, and leave overlapping ghost rows behind.
    const longCjk = `opencodego/${"中文模型".repeat(12)}`;
    const answer = bridge.select("Select model", [
      { label: longCjk, value: "cjk" },
      { label: "opencodego/glm-5.1", value: "glm" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Select model");
    const rows = frame.split("\n");
    const labelRows = rows.filter((line) => line.includes("中文模型"));
    expect(labelRows).toHaveLength(1);
    expect(labelRows[0]?.endsWith("…")).toBe(true);
    expect(frame).not.toContain("中文模型中文模型中文模型中文模型中文模型中文模型中文模型中文模型中文模型中文模型中文模型中文模型");
    expect(rows.length).toBeLessThanOrEqual(30);
    instance.stdin.write("\x1b");
    await expect(answer).resolves.toBeUndefined();
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
    expect(instance.lastFrame()).toContain("⚠ full · shift+tab to cycle");
    expect(instance.lastFrame()).not.toContain("bypass permissions on");

    // Merge/rollback confirms are not short-circuited.
    const merge = bridge.ask("Merge changes?");
    expect(bridge.confirmPending).toBe(true);
    bridge.answerConfirmation(false);
    await expect(merge).resolves.toBe(false);
  });

  it("answers every approval from one choice list: Esc and the default Enter deny", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

    const first = bridge.ask("Merge changes? [y/N]", "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b");
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Merge changes?");
    expect(frame).not.toContain("[y/N]");
    expect(frame).toContain("› Deny");
    expect(frame).toContain("↑↓ choose · enter confirm · y allow once · n / esc deny");
    instance.stdin.write("\x1b");
    await expect(first).resolves.toBe(false);

    const second = bridge.ask("Rollback?", "detail");
    await tick();
    instance.stdin.write("\r");
    await expect(second).resolves.toBe(false);

    const third = bridge.ask("Rollback?", "detail");
    await tick();
    instance.stdin.write("\x1b[A");
    await tick();
    instance.stdin.write("\r");
    await expect(third).resolves.toBe(true);

    const permission = bridge.select("Run this shell command?", [
      { label: "Allow once", value: "once", scope: "this call only" },
      { label: "Deny", value: "deny" },
      { label: "Deny and tell the model why", value: "deny-reason" },
    ], "rm -rf build");
    await tick();
    const permissionFrame = instance.lastFrame() ?? "";
    expect(permissionFrame).toContain("rm -rf build");
    expect(permissionFrame).toContain("Allow once  this call only");
    expect(permissionFrame).toContain("› Deny");
    instance.stdin.write("y");
    await expect(permission).resolves.toBe("once");

    const cancelled = bridge.select("Run this shell command?", [
      { label: "Allow once", value: "once" },
      { label: "Deny", value: "deny" },
    ], "rm -rf dist");
    await tick();
    instance.stdin.write("\x1b");
    await expect(cancelled).resolves.toBeUndefined();
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
    expect(compacting).toContain("compacting…");
    expect(compacting).not.toContain("think:off · perm:auto · compacting...");

    bridge.sink.onContextCompaction?.({
      stage: "success",
      mode: "automatic",
      before: 80,
      after: 20,
      usage: { inputTokens: 1, outputTokens: 1, cacheTokens: 0, reasoningTokens: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).not.toContain("· compacting…");
    expect(instance.lastFrame()).toContain("Context compacted: 80 → 20 messages.");
  });

  it("clears the compaction status when compaction ends, whatever the outcome", () => {
    let state = reduceEvent(emptyView(), {
      kind: "context-compaction",
      event: { stage: "start", mode: "manual", before: 20 },
    });
    expect(state.statuses.context).toBe("compacting…");
    state = reduceEvent(state, {
      kind: "context-compaction",
      event: { stage: "failure", mode: "manual", before: 20, error: "provider unavailable" },
    });
    expect(state.statuses.context).toBeUndefined();
  });

  it("shows a widget without its own panel as a transcript notice", async () => {
    const bridge = new TuiSessionBridge();
    const instance = render(React.createElement(App, {
      session: createSession(new ExtensionHost()),
      bridge,
      cwd: "/tmp/project",
      async onExit() {},
    }));
    bridge.sink.setWidget?.("xiocode-status", ["evolve: 3 runs recorded", "context: 2 hints"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(instance.lastFrame()).toContain("evolve: 3 runs recorded");
    expect(instance.lastFrame()).toContain("context: 2 hints");
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
    // Slash menu portal renders floating above the composer input box
    expect(frame.indexOf("effort")).toBeLessThan(frame.lastIndexOf(theme.sym.prompt));
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

describe("InputCandidateRegion & ComposerChrome", () => {
  it("renders two horizontal lines without enclosing boxes in idle state", () => {
    const output = renderToString(React.createElement(InputCandidateRegion, {
      active: false,
      busy: false,
      composer: React.createElement(ComposerChrome, {
        composer: emptyComposer(),
        busy: false,
        noBorder: true,
      }),
    }));
    // Has horizontal border lines
    expect(output).toContain("─");
    expect(output).toContain(theme.sym.prompt);
    expect(output).toContain("Ask a question");
    // No enclosing box borders
    expect(output).not.toContain("╭");
    expect(output).not.toContain("╰");
    expect(output).not.toContain("│");
  });

  it("renders candidate suggestions cleanly within the two horizontal lines", () => {
    const candidateMenu = React.createElement(Text, null, "› /help        Show help");
    const output = renderToString(React.createElement(InputCandidateRegion, {
      active: true,
      busy: false,
      candidateMenu,
      composer: React.createElement(ComposerChrome, {
        composer: setComposerText(emptyComposer(), "/h"),
        busy: false,
        noBorder: true,
      }),
    }));
    expect(output).toContain("─");
    expect(output).toContain("› /help");
    expect(output).toContain(theme.sym.prompt);
    expect(output).not.toContain("╭");
    expect(output).not.toContain("╰");
    expect(output).not.toContain("│");
  });

  it("renders standalone ComposerChrome with horizontal borders", () => {
    const output = renderToString(React.createElement(ComposerChrome, {
      composer: setComposerText(emptyComposer(), "hello"),
      busy: false,
    }));
    expect(output).toContain("─");
    expect(output).toContain("hello");
    expect(output).not.toContain("╭");
    expect(output).not.toContain("╰");
    expect(output).not.toContain("│");
  });
});

function emptyView(): ViewState {
  return { statuses: {}, widgets: {} };
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
    getCostSummary: () => ({ totalTokens: 0, costUsd: null, hasUnpriced: false }),
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
    rewind: { list: () => [], run: async () => ({ skipped: true, summary: "" }) },
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
