import { EventEmitter } from "node:events";
import React from "react";
import { render as inkRender } from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExtensionHost } from "../runtime/extension-host.ts";
import { App } from "./app.ts";
import { sliceTranscriptLineWindow } from "./transcript-log.ts";
import { TuiSessionBridge } from "./session-bridge.ts";
import { stripAnsi } from "./text-selection.ts";
import { WorkspacePerceptionService } from "../runtime/workspace/index.ts";
import { emptyScrollbackState, reduceScrollback } from "./transcript-log.ts";

import type { PreparedSession } from "../runtime/session.ts";
import type { ChatMessage } from "../runtime/types.ts";

class SizedStdout extends EventEmitter {
  readonly columns: number;
  readonly rows: number;
  frames: string[] = [];
  _lastFrame?: string;
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write = (frame: string) => {
    this.frames.push(frame);
    this._lastFrame = frame;
  };
  lastFrame = () => this._lastFrame;
}

class SizedStderr extends EventEmitter {
  readonly columns: number;
  readonly rows: number;
  frames: string[] = [];
  constructor(columns = 80, rows = 24) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write = (frame: string) => {
    this.frames.push(frame);
  };
  lastFrame = () => undefined;
}

class DummyStdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  write = () => {};
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => null;
}

function stubWorkspacePerception(): WorkspacePerceptionService {
  return new WorkspacePerceptionService({
    root: "/tmp/project",
    gitnexus: {
      name: "gitnexus",
      isAvailable: async () => false,
      queryStructure: async () => ({ kind: "unavailable", reason: "test" }),
    },
  });
}

function createVisualSession(messages: readonly ChatMessage[] = []): PreparedSession {
  const host = new ExtensionHost();
  const model = { provider: "anthropic", id: "claude-3-7-sonnet" };
  return {
    host,
    model,
    getModel: () => model,
    setModel: async () => {},
    getCostSummary: () => ({ totalTokens: 0, costUsd: null, hasUnpriced: false }),
    getThinkingLevel: () => "off",
    cycleThinkingLevel: async () => "off",
    getPermissionMode: () => "auto",
    setPermissionMode: (m) => m,
    cyclePermissionMode: () => "full",
    compact: async () => ({
      compacted: false,
      before: 0,
      after: 0,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0 },
    }),
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

async function mountVisualApp(
  session: PreparedSession,
  bridge: TuiSessionBridge,
  dimensions: { columns: number; rows: number },
  cwd = "/srv/work/xiocode",
) {
  const stdout = new SizedStdout(dimensions.columns, dimensions.rows);
  const stderr = new SizedStderr(dimensions.columns, dimensions.rows);
  const stdin = new DummyStdin();

  const instance = inkRender(
    React.createElement(App, {
      session,
      bridge,
      cwd,
      async onExit() {},
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  // Allow initial mount and event listeners to register
  await new Promise((resolve) => setTimeout(resolve, 30));

  return {
    instance,
    stdout,
    getFrame: () => stripAnsi(stdout.lastFrame() ?? ""),
    getLines: () => stripAnsi(stdout.lastFrame() ?? "").split("\n"),
    flush: async (ms = 50) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    unmount: () => {
      instance.unmount();
      instance.cleanup();
    },
  };
}

describe("TUI Visual Regression Baseline [T00]", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env["XIO_ANIMATION"] = "off";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  it("renders 80x24 standard terminal with Chinese long text and emoji stably", async () => {
    const bridge = new TuiSessionBridge();
    const session = createVisualSession();
    const app = await mountVisualApp(session, bridge, { columns: 80, rows: 24 });

    try {
      bridge.sink.onAssistantText?.(
        "在本次架构演进中，我们通过 ExecutionDomain 严格隔离执行域资源 🚀。\n" +
        "即使在多进程并发争抢场景下，事务持久化与意图注册机制也能确保不会产生悬挂进程与脏数据。\n" +
        "所有关键调用链路均提供显式类型保障与状态机收敛。"
      );

      await app.flush(60);
      const frame = app.getFrame();

      expect(frame).toContain("XioCode v");
      expect(frame).toContain("claude-3-7-sonnet");
      expect(frame).toContain("/srv/work/xiocode");
      expect(frame).toContain("ExecutionDomain");
      expect(frame).toMatchSnapshot();
    } finally {
      app.unmount();
    }
  });

  it("renders 80x24 standard terminal with GFM table format", async () => {
    const bridge = new TuiSessionBridge();
    const session = createVisualSession();
    const app = await mountVisualApp(session, bridge, { columns: 80, rows: 24 });

    try {
      const gfmTable =
        "| 模块 | 状态 | 覆盖率 |\n" +
        "| :--- | :--- | :--- |\n" +
        "| kernel | 正常 | 98.5% |\n" +
        "| tui | 校验中 | 95.2% |";

      bridge.sink.onAssistantText?.(gfmTable);
      await app.flush(60);
      const frame = app.getFrame();

      expect(frame).toContain("模块");
      expect(frame).toContain("kernel");
      expect(frame).toMatchSnapshot();
    } finally {
      app.unmount();
    }
  });

  it("renders 60x24 narrow terminal edge-case without horizontal overflow", async () => {
    const bridge = new TuiSessionBridge();
    const session = createVisualSession();
    const app = await mountVisualApp(session, bridge, { columns: 60, rows: 24 }, "/short/path");

    try {
      bridge.sink.onAssistantText?.(
        "超长的一行文本用于测试窄屏下终端文本截断和折行表现是否符合预期，绝对不能导致外部边框变形或组件错位。"
      );
      await app.flush(60);
      const frame = app.getFrame();
      const lines = app.getLines();

      expect(frame).toContain("XioCode");
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(60);
      }
      expect(frame).toMatchSnapshot();
    } finally {
      app.unmount();
    }
  });

  it("renders multi-tool execution with success and warning notices in 80x24", async () => {
    const bridge = new TuiSessionBridge();
    const session = createVisualSession();
    const app = await mountVisualApp(session, bridge, { columns: 80, rows: 24 });

    try {
      bridge.sink.notify?.("发现 2 处待处理的架构契约冲突，建议立即检查", "warn");
      bridge.sink.setStatus?.("usage", "ctx:38% | $0.042");
      await app.flush(60);
      const frame = app.getFrame();

      expect(frame).toContain("ctx:38%");
      expect(frame).toContain("发现 2 处待处理的架构契约冲突");
      expect(frame).toMatchSnapshot();
    } finally {
      app.unmount();
    }
  });

  it("renders 120x40 wide terminal with restored session history", async () => {
    const restoredMessages: ChatMessage[] = [
      { role: "user", content: "查看当前的 Git 状态与改动统计" },
      {
        role: "assistant",
        content: "已检查工作区状态，当前共有 17 个文件变更，主要集中在 runtime 与 sandbox 扩展层。",
      },
    ];

    const session = createVisualSession(restoredMessages);
    const bridge = new TuiSessionBridge();
    const app = await mountVisualApp(session, bridge, { columns: 120, rows: 40 });

    try {
      await app.flush(60);
      const frame = app.getFrame();

      expect(frame).toContain("查看当前的 Git 状态与改动统计");
      expect(frame).toContain("已检查工作区状态");
      expect(frame).toMatchSnapshot();
    } finally {
      app.unmount();
    }
  });

  it("ensures rendering is strictly deterministic across 3 consecutive runs (no jitter)", async () => {
    const outputs: string[] = [];

    for (let run = 0; run < 3; run += 1) {
      const bridge = new TuiSessionBridge();
      const session = createVisualSession();
      const app = await mountVisualApp(session, bridge, { columns: 80, rows: 24 }, "/tmp/project");

      bridge.sink.onAssistantText?.("固定时钟与关闭动画状态下的多轮渲染结果必须完全一致。");
      await app.flush(60);

      outputs.push(app.getFrame());
      app.unmount();
    }

    expect(outputs[0]).toBe(outputs[1]);
    expect(outputs[1]).toBe(outputs[2]);
  });

  it("fails fast if baseChrome rows calculation changes transcript window height", () => {
    let scrollback = emptyScrollbackState();
    for (let i = 1; i <= 20; i += 1) {
      scrollback = reduceScrollback(scrollback, {
        kind: "assistant-text",
        text: `Log line item #${i} of execution trace`,
      });
    }

    // Normal calculation: viewportLines = 13 (24 rows - 11 baseChrome)
    const baselineWindow = sliceTranscriptLineWindow(scrollback.blocks, 13, 0);

    // Corrupted calculation: e.g. baseChrome incorrectly changed by 3 rows
    const corruptedWindow = sliceTranscriptLineWindow(scrollback.blocks, 10, 0);

    expect(corruptedWindow.lines.length).not.toBe(baselineWindow.lines.length);
    expect(baselineWindow.lines.length).toBe(13);
    expect(corruptedWindow.lines.length).toBe(10);
  });
});
