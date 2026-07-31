import { describe, expect, it } from "vitest";

import { CONTEXT_SUMMARY_NAME } from "../runtime/context-compaction.ts";
import { SESSION_RECOVERY_NAME } from "../runtime/session-recovery.ts";
import {
  adjacentExpandableHistoryBlock,
  appendUserBlock,
  blocksFromRestoredMessages,
  emptyScrollbackState,
  expandableHistoryBlocks,
  formatLiveLines,
  latestExpandableToolBlock,
  liveTextString,
  reduceScrollback,
  sliceTranscriptLineWindow,
  type HistoryBlock,
} from "./transcript-log.ts";
import { createDeltaCoalescer, mergeSoftDeltas } from "./delta-coalesce.ts";

describe("reduceScrollback", () => {
  it("streams thinking then commits collapsed think on tool-start", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, { kind: "thinking-delta", text: "plan A" });
    expect(state.live?.kind).toBe("thinking");
    // Working state echoes the thinking tail under a tree branch.
    expect(formatLiveLines(state.live!, state.inFlightTools)).toEqual(["▸ Thinking…", "  └ plan A"]);

    state = reduceScrollback(state, {
      kind: "tool-start",
      name: "read",
      detail: "README.md",
      callId: "c1",
    });
    expect(state.inFlightTools).toHaveLength(1);
    expect(state.blocks.some((b) => b.kind === "thinking")).toBe(true);
    const thinking = state.blocks.find((b) => b.kind === "thinking")!;
    expect(thinking.lines[0]).toMatch(/Thought for \d+s.*Ctrl\+O/);
    expect(thinking.lines[1]).toBe("  └ plan A");
    expect(thinking.output).toBe("plan A");
  });

  it("pairs parallel same-name tools by callId completing out of order", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, {
      kind: "tool-start",
      name: "read",
      detail: "a.ts",
      callId: "r1",
    });
    state = reduceScrollback(state, {
      kind: "tool-start",
      name: "read",
      detail: "b.ts",
      callId: "r2",
    });
    expect(state.inFlightTools).toHaveLength(2);
    expect(formatLiveLines(state.live, state.inFlightTools).join("\n")).toContain("a.ts");
    expect(formatLiveLines(state.live, state.inFlightTools).join("\n")).toContain("b.ts");

    // Finish second first — must not attach to first start.
    state = reduceScrollback(state, {
      kind: "tool-end",
      name: "read",
      error: false,
      output: "body-b",
      callId: "r2",
    });
    expect(state.inFlightTools).toHaveLength(1);
    expect(state.inFlightTools[0]?.callId).toBe("r1");
    expect(state.blocks.filter((b) => b.kind === "tool")).toHaveLength(1);
    expect(state.blocks.find((b) => b.kind === "tool")).toMatchObject({
      callId: "r2",
      detail: "b.ts",
      output: "body-b",
    });

    state = reduceScrollback(state, {
      kind: "tool-end",
      name: "read",
      error: false,
      output: "body-a",
      callId: "r1",
    });
    expect(state.inFlightTools).toHaveLength(0);
    const tools = state.blocks.filter((b) => b.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ callId: "r2", detail: "b.ts", output: "body-b" });
    expect(tools[1]).toMatchObject({ callId: "r1", detail: "a.ts", output: "body-a" });
    // No stale in-flight row after both complete.
    expect(formatLiveLines(state.live, state.inFlightTools)).toEqual([]);
  });

  it("retains full tool output while Static keeps a bounded tree preview", () => {
    let state = emptyScrollbackState();
    const long = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n");
    state = reduceScrollback(state, {
      kind: "tool-start",
      name: "bash",
      detail: "seq",
      callId: "c1",
    });
    state = reduceScrollback(state, {
      kind: "tool-end",
      name: "bash",
      error: false,
      output: long,
      callId: "c1",
    });
    const tool = state.blocks.find((b) => b.kind === "tool");
    expect(tool?.output).toBe(long);
    expect(tool?.previewCollapsed).toBe(true);
    expect(tool?.lines.join("\n")).toContain("Ctrl+O");
    // Tree preview: first rows nested under the header, rest stays in Ctrl+O.
    expect(tool?.lines[1]).toBe("  └ line0");
    expect(tool?.lines.join("\n")).toContain("line2");
    expect(tool?.lines.join("\n")).not.toContain("line3");
    expect(tool?.lines.join("\n")).not.toContain("line11");
    expect(latestExpandableToolBlock(state)?.output).toBe(long);
  });

  it("labels explore tools as subagent in history", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, {
      kind: "tool-start",
      name: "explore",
      detail: "survey package layer",
      callId: "e1",
    });
    expect(formatLiveLines(state.live, state.inFlightTools).join("\n")).toMatch(/subagent/);
    expect(formatLiveLines(state.live, state.inFlightTools).join("\n")).toContain("survey package layer");

    state = reduceScrollback(state, {
      kind: "tool-end",
      name: "explore",
      error: false,
      output: "## Explore report (ok)\nmodel: p/m\nturns: 1  tool_calls: 2  tool_errors: 0\n\nfound X",
      callId: "e1",
    });
    const tool = state.blocks.find((b) => b.kind === "tool");
    expect(tool).toBeDefined();
    expect(tool!.lines[0]).toMatch(/subagent done/);
    expect(tool!.lines.join("\n")).toContain("found X");
    expect(tool!.lines.join("\n")).not.toContain("model: p/m");
    expect(tool!.output).toContain("model: p/m");
  });

  it("streams nested subagent workers without touching primary live buffer", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, { kind: "assistant-delta", text: "primary" });
    expect(state.live?.kind).toBe("assistant");

    state = reduceScrollback(state, {
      kind: "subagent-start",
      workerId: 1,
      model: "stub/flash",
      role: "locator",
      goal: "survey auth",
    });
    state = reduceScrollback(state, { kind: "subagent-thinking-delta", workerId: 1, text: "plan" });
    const thinkingWorker = state.inFlightSubagents[0]!;
    const thinkingStartedAt = thinkingWorker.activity.kind === "thinking"
      ? thinkingWorker.activity.startedAt
      : thinkingWorker.startedAt;
    expect(formatLiveLines(state.live, state.inFlightTools, state.inFlightSubagents, {
      now: thinkingStartedAt + 5_000,
    }).join("\n")).toContain("Thinking 5s");
    state = reduceScrollback(state, {
      kind: "subagent-tool-start",
      workerId: 1,
      name: "read",
      detail: "src/auth.ts",
      callId: "w1:read-1",
    });
    state = reduceScrollback(state, {
      kind: "subagent-tool-end",
      workerId: 1,
      name: "read",
      error: false,
      output: "export function auth() {}",
      callId: "w1:read-1",
    });
    state = reduceScrollback(state, { kind: "subagent-assistant-delta", workerId: 1, text: "found auth" });
    state = reduceScrollback(state, { kind: "subagent-end", workerId: 1, success: true, status: "success" });

    expect(state.live?.kind).toBe("assistant");
    expect(state.inFlightSubagents).toHaveLength(0);
    const block = state.blocks.find((b) => b.kind === "subagent");
    expect(block).toBeDefined();
    expect(block!.lines.join("\n")).toMatch(/subagent #1/);
    expect(block!.lines.join("\n")).toContain("found auth");
    expect(block!.lines.join("\n")).toContain("Ctrl+O");
    // Tool-call history collapsed out of Static; retained in output for Ctrl+O.
    expect(block!.lines.join("\n")).not.toMatch(/\bread\b.*done/);
    expect(block!.output).toMatch(/read/);
    expect(block!.output).toContain("plan");
    expect(block!.output).toContain("export function auth() {}");
  });

  it("isolates parallel subagent workers by workerId", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, {
      kind: "subagent-start",
      workerId: 1,
      model: "stub/a",
      goal: "slice A",
    });
    state = reduceScrollback(state, {
      kind: "subagent-start",
      workerId: 2,
      model: "stub/b",
      goal: "slice B",
    });
    state = reduceScrollback(state, { kind: "subagent-assistant-delta", workerId: 1, text: "A-only" });
    state = reduceScrollback(state, { kind: "subagent-assistant-delta", workerId: 2, text: "B-only" });
    const live = formatLiveLines(state.live, state.inFlightTools, state.inFlightSubagents).join("\n");
    expect(live).toContain("Responding");
    expect(live).not.toContain("A-only");
    expect(live).not.toContain("B-only");
    expect(live).toContain("slice A");
    expect(live).toContain("slice B");
    expect(liveTextString(state.inFlightSubagents[0]!.live!.buffer)).toBe("A-only");
    expect(liveTextString(state.inFlightSubagents[1]!.live!.buffer)).toBe("B-only");
  });

  it("keeps folded thinking and tool history navigable in transcript order", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, { kind: "thinking-delta", text: "inspect the code" });
    state = reduceScrollback(state, { kind: "assistant-delta", text: "next" });
    state = reduceScrollback(state, { kind: "assistant-text", text: "next" });
    state = reduceScrollback(state, {
      kind: "tool-start",
      name: "read",
      detail: "src/main.ts",
      callId: "read-1",
    });
    state = reduceScrollback(state, {
      kind: "tool-end",
      name: "read",
      error: false,
      output: "export const x = 1;",
      callId: "read-1",
    });

    const expandable = expandableHistoryBlocks(state);
    expect(expandable.map((block) => block.kind)).toEqual(["thinking", "tool"]);
    const latest = latestExpandableToolBlock(state)!;
    expect(latest.kind).toBe("tool");
    expect(adjacentExpandableHistoryBlock(state, latest.id, -1)).toMatchObject({
      kind: "thinking",
      output: "inspect the code",
    });
    expect(adjacentExpandableHistoryBlock(state, expandable[0]!.id, 1)).toMatchObject({
      kind: "tool",
      output: "export const x = 1;",
    });
  });

  it("records an interrupted nested tool when a subagent ends early", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, {
      kind: "subagent-start",
      workerId: 4,
      model: "stub/flash",
      goal: "run checks",
    });
    state = reduceScrollback(state, {
      kind: "subagent-tool-start",
      workerId: 4,
      name: "bash",
      detail: "npm test",
      callId: "w4:b1",
    });
    state = reduceScrollback(state, {
      kind: "subagent-end",
      workerId: 4,
      success: false,
      status: "cancelled",
    });

    const block = state.blocks.find((entry) => entry.kind === "subagent");
    expect(block?.lines[0]).toContain("cancelled");
    expect(block?.output).toContain("bash npm test interrupted");
  });

  it("keeps tool body non-empty after tool-end", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, {
      kind: "tool-start",
      name: "bash",
      detail: "ls",
      callId: "b1",
    });
    state = reduceScrollback(state, {
      kind: "tool-end",
      name: "bash",
      error: false,
      output: "exit_code=0\n\nstdout:\nAGENTS.md\nREADME.md\n\n\nstderr:\n",
      callId: "b1",
    });
    expect(state.live).toBeUndefined();
    const tool = state.blocks.find((b) => b.kind === "tool");
    expect(tool).toBeDefined();
    expect(tool!.lines.join("\n")).toContain("done");
    expect(tool!.lines.join("\n")).toContain("Ctrl+O");
    expect(tool!.output).toContain("AGENTS.md");
  });

  it("appends user lines into immutable history blocks", () => {
    let state = emptyScrollbackState();
    state = appendUserBlock(state, "调研一下本仓库");
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]!.lines[0]).toContain("调研一下本仓库");
  });

  it("restores prior chat messages as static blocks", () => {
    const state = blocksFromRestoredMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]!.kind).toBe("user");
    expect(state.blocks[1]!.kind).toBe("assistant");
  });

  it("restores context-compaction and execution-recovery notices including completion unknown", () => {
    const state = blocksFromRestoredMessages([
      { role: "user", content: "hi" },
      { role: "system", name: CONTEXT_SUMMARY_NAME, content: "[context summary]\nprivate" },
      {
        role: "system",
        name: SESSION_RECOVERY_NAME,
        content: "tool interrupted: completion unknown for bash; inspect workspace state before retrying",
      },
    ]);
    const notices = state.blocks.filter((b) => b.kind === "notice");
    expect(notices.some((n) => n.lines.join(" ").includes("compacted"))).toBe(true);
    expect(notices.some((n) => n.lines.join(" ").includes("completion unknown"))).toBe(true);
  });

  it("assigns synthetic callId when provider omits one", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, {
      kind: "tool-start",
      name: "bash",
      detail: "echo",
    });
    expect(state.inFlightTools[0]?.callId).toMatch(/^synthetic-/);
    state = reduceScrollback(state, {
      kind: "tool-end",
      name: "bash",
      error: false,
      output: "hi",
    });
    expect(state.inFlightTools).toHaveLength(0);
    expect(state.blocks.find((b) => b.kind === "tool")?.output).toBe("hi");
  });

  it("replays 10K assistant deltas without loss or reordering", () => {
    let state = emptyScrollbackState();
    const parts: string[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const piece = i % 10 === 0 ? `W${i}` : "x";
      parts.push(piece);
      state = reduceScrollback(state, { kind: "assistant-delta", text: piece });
    }
    const expected = parts.join("");
    expect(state.live?.kind).toBe("assistant");
    expect(liveTextString(state.live!.buffer)).toBe(expected);
    expect(state.live!.buffer.length).toBe(expected.length);

    state = reduceScrollback(state, { kind: "assistant-text", text: expected });
    expect(state.live).toBeUndefined();
    const block = state.blocks.find((b) => b.kind === "assistant");
    expect(block?.lines.join("\n")).toContain(expected);
  });

  it("keeps finalized Static blocks immutable across later deltas", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, { kind: "assistant-delta", text: "done" });
    state = reduceScrollback(state, { kind: "assistant-text", text: "done" });
    const finalized = state.blocks[0]!;
    state = reduceScrollback(state, { kind: "assistant-delta", text: "next" });
    expect(state.blocks[0]).toBe(finalized);
    expect(state.blocks[0]!.lines).toBe(finalized.lines);
  });

  it("bounds sticky live preview while retaining full buffer", () => {
    let state = emptyScrollbackState();
    const long = "a".repeat(8_000);
    state = reduceScrollback(state, { kind: "assistant-delta", text: long });
    expect(liveTextString(state.live!.buffer)).toBe(long);
    const lines = formatLiveLines(state.live, state.inFlightTools, [], { charBudget: 100 });
    expect(lines[0]!.length).toBeLessThan(long.length);
    expect(lines[0]).toContain("…");
    expect(lines[0]!.endsWith("a".repeat(20))).toBe(true);
  });

  it("animates live chrome when a spinner frame is provided, static otherwise", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, { kind: "thinking-delta", text: "plan" });
    expect(formatLiveLines(state.live, [], [], { spinnerFrame: "⠋" }))
      .toEqual(["▸ Thinking… ⠋", "  └ plan"]);

    state = emptyScrollbackState();
    state = reduceScrollback(state, { kind: "assistant-delta", text: "hello" });
    // Streaming answer gets the ▊ cursor; running tools get the spinner tail.
    state = reduceScrollback(state, { kind: "tool-start", name: "read", detail: "a.ts", callId: "c1" });
    const lines = formatLiveLines(state.live, state.inFlightTools, [], { spinnerFrame: "⠙" });
    expect(lines.find((line) => line.includes("read"))).toContain("⠙");

    // Reduced motion (no frame) keeps today's static chrome — no cursor, no spinner.
    const staticLines = formatLiveLines(state.live, state.inFlightTools);
    expect(staticLines.join("\n")).not.toContain("⠙");
    expect(staticLines.join("\n")).not.toContain("▊");
  });

  it("appends the stream cursor to the live assistant preview", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, { kind: "assistant-delta", text: "hello" });
    const lines = formatLiveLines(state.live, [], [], { spinnerFrame: "⠋" });
    expect(lines[0]).toBe("● hello▊");
  });

  it("formatLiveLines stays near-linear as stream grows (no full rejoin per paint)", () => {
    const { performance } = require("node:perf_hooks") as typeof import("node:perf_hooks");
    let state = emptyScrollbackState();
    const run = (n: number): number => {
      state = emptyScrollbackState();
      for (let i = 0; i < n; i += 1) {
        state = reduceScrollback(state, { kind: "assistant-delta", text: "x" });
      }
      const t0 = performance.now();
      for (let p = 0; p < 50; p += 1) {
        formatLiveLines(state.live, state.inFlightTools, [], { charBudget: 4_000 });
      }
      return performance.now() - t0;
    };
    // Warm
    run(1_000);
    const small = run(2_000);
    const large = run(20_000);
    // 10× more tokens should not cost 50× (quadratic would blow up).
    expect(large).toBeLessThan(Math.max(small * 25, 50));
  });
});

describe("delta coalescer", () => {
  it("merges soft deltas and flushes immediately on hard events", () => {
    const flushes: string[][] = [];
    const timers: Array<() => void> = [];
    const coalescer = createDeltaCoalescer((events) => {
      flushes.push(events.map((e) => e.kind));
    }, {
      frameMs: 16,
      schedule: (fn) => {
        timers.push(fn);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: () => {
        timers.length = 0;
      },
    });

    coalescer.push({ kind: "assistant-delta", text: "a" });
    coalescer.push({ kind: "assistant-delta", text: "b" });
    expect(flushes).toHaveLength(0);
    expect(coalescer.pendingCount()).toBe(2);

    coalescer.push({
      kind: "tool-start",
      name: "read",
      detail: "f",
      callId: "1",
    });
    // soft batch then hard event
    expect(flushes).toEqual([["assistant-delta", "assistant-delta"], ["tool-start"]]);
    expect(coalescer.pendingCount()).toBe(0);
  });

  it("mergeSoftDeltas concatenates consecutive same-kind pieces", () => {
    const merged = mergeSoftDeltas([
      { kind: "assistant-delta", text: "a" },
      { kind: "assistant-delta", text: "b" },
      { kind: "thinking-delta", text: "t" },
      { kind: "thinking-delta", text: "u" },
    ]);
    expect(merged).toEqual([
      { kind: "assistant-delta", text: "ab" },
      { kind: "thinking-delta", text: "tu" },
    ]);
  });
});

describe("subagent purpose naming", () => {
  it("shows the primary-chosen name on live rows and the finished block", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, {
      kind: "subagent-start",
      workerId: 7,
      model: "stub/flash",
      role: "locator",
      name: "auth flow",
      goal: "survey the auth flow entrypoints",
    });
    const live = formatLiveLines(state.live, state.inFlightTools, state.inFlightSubagents).join("\n");
    expect(live).toContain("subagent #7 · auth flow");

    state = reduceScrollback(state, { kind: "subagent-assistant-text", workerId: 7, text: "found it" });
    state = reduceScrollback(state, { kind: "subagent-end", workerId: 7, success: true, status: "success" });
    const block = state.blocks.find((b) => b.kind === "subagent")!;
    expect(block.lines[0]).toContain("subagent #7 · auth flow");
  });

  it("omits the name separator when no name was provided", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, {
      kind: "subagent-start",
      workerId: 8,
      model: "stub/flash",
      goal: "slice X",
    });
    const live = formatLiveLines(state.live, state.inFlightTools, state.inFlightSubagents).join("\n");
    expect(live).toContain("subagent #8 · stub/flash");
  });
});

describe("sliceTranscriptLineWindow", () => {
  const block = (id: number, kind: HistoryBlock["kind"], lineCount: number): HistoryBlock => ({
    id,
    kind,
    lines: Array.from({ length: lineCount }, (_, i) => `b${id}:${i}`),
  });

  it("scrolls line by line through a block taller than the viewport", () => {
    // Old block-granular window either hid the 30-line report entirely or
    // overflowed the viewport — the reported "scroll and it disappears" bug.
    const blocks = [block(1, "user", 1), block(2, "assistant", 30), block(3, "notice", 1)];
    const bottom = sliceTranscriptLineWindow(blocks, 10, 0);
    expect(bottom.lines).toHaveLength(10);
    expect(bottom.lines.at(-1)!.text).toBe("b3:0");
    // Tail of the tall block is partially visible at the bottom.
    expect(bottom.lines[0]!.text).toBe("b2:21");
    expect(bottom.maxOffset).toBe(22);

    const up3 = sliceTranscriptLineWindow(blocks, 10, 3);
    expect(up3.lines).toHaveLength(10);
    expect(up3.lines[0]!.text).toBe("b2:18");
    expect(up3.lines.at(-1)!.text).toBe("b2:27");
    expect(up3.hiddenBelow).toBe(3);

    const top = sliceTranscriptLineWindow(blocks, 10, 10_000);
    expect(top.offset).toBe(22);
    expect(top.lines[0]!.text).toBe("b1:0");
    expect(top.hiddenAbove).toBe(0);
  });

  it("tags lines with block styling metadata for per-line rendering", () => {
    const blocks = [block(1, "assistant", 2), block(2, "tool", 1)];
    const window = sliceTranscriptLineWindow(blocks, 10, 0);
    expect(window.lines.map((l) => l.blockId)).toEqual([1, 1, 2]);
    expect(window.lines[0]).toMatchObject({ boldFirst: true, compact: false });
    expect(window.lines[1]).toMatchObject({ boldFirst: false, compact: false });
    expect(window.lines[2]).toMatchObject({ kind: "tool", compact: true });
  });
});
