import { describe, expect, it } from "vitest";

import { scrollOffsetForLine, searchTranscriptLines, transcriptFlatLines } from "./transcript-search.ts";
import type { HistoryBlock } from "./transcript-log.ts";

function block(overrides: Partial<HistoryBlock> & { id: number; kind: HistoryBlock["kind"] }): HistoryBlock {
  return {
    lines: [],
    error: false,
    ...overrides,
    title: overrides.title ?? "",
  } as HistoryBlock;
}

describe("transcriptFlatLines", () => {
  it("flattens block lines top to bottom, empty blocks get one row", () => {
    const blocks = [
      block({ id: 1, kind: "assistant", lines: ["hello", "world"] }),
      block({ id: 2, kind: "tool", lines: [] }),
      block({ id: 3, kind: "user", lines: ["ping"] }),
    ];
    expect(transcriptFlatLines(blocks)).toEqual(["hello", "world", "", "ping"]);
  });

  it("strips ANSI styles before matching", () => {
    const blocks = [block({ id: 1, kind: "assistant", lines: ["\u001B[1mfix\u001B[22m the bug"] })];
    expect(transcriptFlatLines(blocks)).toEqual(["fix the bug"]);
  });
});

describe("searchTranscriptLines", () => {
  const blocks = [
    block({ id: 1, kind: "assistant", lines: ["Fix the lint", "then run tests"] }),
    block({ id: 2, kind: "tool", lines: ["npx tsc --noEmit"] }),
    block({ id: 3, kind: "user", lines: ["fix the flaky test"] }),
  ];

  it("finds case-insensitive substring matches with top-based indexes", () => {
    expect(searchTranscriptLines(blocks, "fix")).toEqual([0, 3]);
    expect(searchTranscriptLines(blocks, "TEST")).toEqual([1, 3]);
  });

  it("returns no matches for an empty or whitespace query", () => {
    expect(searchTranscriptLines(blocks, "")).toEqual([]);
    expect(searchTranscriptLines(blocks, "   ")).toEqual([]);
  });

  it("returns no matches for a missing needle", () => {
    expect(searchTranscriptLines(blocks, "nope")).toEqual([]);
  });
});

describe("scrollOffsetForLine", () => {
  it("maps the last line to offset 0 (sticky bottom)", () => {
    expect(scrollOffsetForLine(10, 9)).toBe(0);
    expect(scrollOffsetForLine(10, 10)).toBe(0);
  });

  it("maps earlier lines to increasing offsets", () => {
    expect(scrollOffsetForLine(10, 0)).toBe(9);
    expect(scrollOffsetForLine(10, 4)).toBe(5);
  });
});
