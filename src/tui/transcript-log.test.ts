import { describe, expect, it } from "vitest";

import { CONTEXT_SUMMARY_NAME } from "../runtime/context-compaction.ts";
import { SESSION_RECOVERY_NAME } from "../runtime/session-recovery.ts";
import {
  appendUserBlock,
  blocksFromRestoredMessages,
  emptyScrollbackState,
  formatLiveLines,
  latestExpandableToolBlock,
  liveTextString,
  reduceScrollback,
  toggleLatestScrollbackExpandable,
} from "./transcript-log.ts";
import { createDeltaCoalescer, mergeSoftDeltas } from "./delta-coalesce.ts";

describe("reduceScrollback", () => {
  it("streams thinking then commits collapsed think on tool-start", () => {
    let state = emptyScrollbackState();
    state = reduceScrollback(state, { kind: "thinking-delta", text: "plan A" });
    expect(state.live?.kind).toBe("thinking");
    expect(formatLiveLines(state.live!, state.inFlightTools).some((l) => l.includes("plan A"))).toBe(true);

    state = reduceScrollback(state, {
      kind: "tool-start",
      name: "read",
      detail: "README.md",
      callId: "c1",
    });
    expect(state.inFlightTools).toHaveLength(1);
    expect(state.blocks.some((b) => b.kind === "thinking")).toBe(true);
    expect(state.blocks.find((b) => b.kind === "thinking")!.lines[0]).toMatch(/think \d+s/);
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

  it("retains full tool output while Static lines stay preview-sized", () => {
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
    expect(tool?.lines.join("\n")).toContain("truncated");
    expect(tool?.lines.join("\n")).toContain("line0");
    expect(tool?.lines.join("\n")).not.toContain("line11");
    expect(latestExpandableToolBlock(state)?.output).toBe(long);
    const toggled = toggleLatestScrollbackExpandable(state);
    expect(toggled.blocks.find((b) => b.kind === "tool")?.previewCollapsed).toBe(false);
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
    expect(block!.lines.join("\n")).toContain("read");
    expect(block!.lines.join("\n")).toContain("found auth");
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
    expect(live).toContain("A-only");
    expect(live).toContain("B-only");
    expect(live).toContain("slice A");
    expect(live).toContain("slice B");
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
    const text = tool!.lines.join("\n");
    expect(text).toContain("AGENTS.md");
    expect(text).toContain("done");
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
