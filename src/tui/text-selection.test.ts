import { describe, expect, it } from "vitest";

import { encodeOsc52Clipboard } from "./clipboard.ts";
import {
  cellFromMouse,
  displayWidth,
  estimateContentTopRow,
  extractSelectedText,
  flattenBlockLines,
  highlightLineSegments,
  indexFromDisplayCol,
  orderSelection,
  selectionDragDistance,
  selectionIsEmpty,
  stripAnsi,
} from "./text-selection.ts";
import { consumeMouseChunk } from "./mouse-scroll.ts";

describe("text-selection", () => {
  const lines = ["hello world", "second line", "tail"];

  it("extracts a single-line slice", () => {
    expect(extractSelectedText(lines, {
      anchor: { line: 0, col: 0 },
      head: { line: 0, col: 5 },
    })).toBe("hello");
  });

  it("extracts multi-line with newlines", () => {
    expect(extractSelectedText(lines, {
      anchor: { line: 0, col: 6 },
      head: { line: 2, col: 4 },
    })).toBe("world\nsecond line\ntail");
  });

  it("orders reverse drags", () => {
    const ordered = orderSelection({
      anchor: { line: 1, col: 3 },
      head: { line: 0, col: 1 },
    });
    expect(ordered).toEqual({
      start: { line: 0, col: 1 },
      end: { line: 1, col: 3 },
    });
    expect(extractSelectedText(lines, {
      anchor: { line: 1, col: 3 },
      head: { line: 0, col: 1 },
    })).toBe("ello world\nsec");
  });

  it("maps mouse into content cells", () => {
    const top = estimateContentTopRow({ scrolled: false });
    expect(cellFromMouse({
      col: 3,
      row: top,
      contentTopRow: top,
      lines,
    })).toEqual({ line: 0, col: 2 });
    expect(cellFromMouse({
      col: 1,
      row: top - 1,
      contentTopRow: top,
      lines,
    })).toBeUndefined();
  });

  it("clamps clicks in empty band below short transcripts", () => {
    const top = 5;
    expect(cellFromMouse({
      col: 1,
      row: 20,
      contentTopRow: top,
      contentBottomRow: 30,
      lines,
      clampToBand: true,
    })).toEqual({ line: 2, col: 4 });
  });

  it("strips ANSI so assistant markdown columns match mouse cols", () => {
    const styled = `\u001B[1m\u001B[36mhello\u001B[39m\u001B[22m`;
    expect(stripAnsi(styled)).toBe("hello");
    expect(flattenBlockLines([{ lines: [styled, "plain"] }])).toEqual(["hello", "plain"]);
  });

  it("maps CJK display columns to string indices", () => {
    const line = "● 你好";
    // ●(1) + space(1) + 你(2) + 好(2) → display width 6
    expect(displayWidth(line)).toBe(6);
    // mouse display col 2 (0-based) is start of 你
    expect(indexFromDisplayCol(line, 2)).toBe(2);
    expect(indexFromDisplayCol(line, 4)).toBe(3);
    expect(cellFromMouse({
      col: 3, // 1-based → display 2
      row: 5,
      contentTopRow: 5,
      lines: [line],
    })).toEqual({ line: 0, col: 2 });
  });

  it("builds highlight segments", () => {
    const range = {
      anchor: { line: 0, col: 1 },
      head: { line: 0, col: 4 },
    };
    expect(highlightLineSegments("abcdef", 0, range)).toEqual([
      { text: "a", selected: false },
      { text: "bcd", selected: true },
      { text: "ef", selected: false },
    ]);
    expect(highlightLineSegments("abcdef", 1, range)).toBeUndefined();
  });

  it("flattens block lines and tracks drag distance", () => {
    expect(flattenBlockLines([
      { lines: ["a", "b"] },
      { lines: ["c"] },
    ])).toEqual(["a", "b", "c"]);
    expect(selectionIsEmpty({
      anchor: { line: 1, col: 2 },
      head: { line: 1, col: 2 },
    })).toBe(true);
    expect(selectionDragDistance({
      anchor: { line: 0, col: 0 },
      head: { line: 2, col: 3 },
    })).toBe(5);
  });
});

describe("clipboard OSC 52", () => {
  it("encodes base64 payload", () => {
    const encoded = encodeOsc52Clipboard("hi");
    expect(encoded.startsWith("\x1b]52;c;")).toBe(true);
    expect(encoded.endsWith("\x07")).toBe(true);
    const b64 = encoded.slice("\x1b]52;c;".length, -1);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("hi");
  });
});

describe("consumeMouseChunk pointer", () => {
  it("emits down/drag/up for left button SGR", () => {
    const events: Array<{ kind: string; col: number; row: number }> = [];
    consumeMouseChunk("\x1b[<0;4;8M\x1b[<32;6;8M\x1b[<0;6;8m", {
      onPointer: (kind, col, row) => events.push({ kind, col, row }),
    });
    expect(events).toEqual([
      { kind: "down", col: 4, row: 8 },
      { kind: "drag", col: 6, row: 8 },
      { kind: "up", col: 6, row: 8 },
    ]);
  });

  it("still scrolls on wheel and ignores other buttons", () => {
    const scrolls: string[] = [];
    const pointers: string[] = [];
    consumeMouseChunk("\x1b[<64;1;1M\x1b[<1;2;3M\x1b[<65;1;1M", {
      onScroll: (dir) => scrolls.push(dir),
      onPointer: (kind) => pointers.push(kind),
    });
    expect(scrolls).toEqual(["up", "down"]);
    expect(pointers).toEqual([]);
  });
});
