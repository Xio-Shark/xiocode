import { describe, expect, it } from "vitest";

import {
  applyInputChunk,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  deleteWordForward,
  emptyComposer,
  historyDown,
  historyUp,
  insertAtCursor,
  killToCursor,
  loadQueueIntoDraft,
  moveCursor,
  moveCursorLine,
  moveCursorTo,
  moveCursorWord,
  parseBusySubmitIntent,
  queueWhileBusy,
  rememberSubmission,
  setComposerText,
  sliceViewerWindow,
} from "./composer.ts";

describe("composer", () => {
  it("moves the cursor left and right without mutating text", () => {
    let state = setComposerText(emptyComposer(), "hello");
    state = moveCursor(state, -2);
    expect(state.cursor).toBe(3);
    state = insertAtCursor(state, "X");
    expect(state.text).toBe("helXlo");
    expect(state.cursor).toBe(4);
  });

  it("deletes Unicode graphemes safely", () => {
    let state = setComposerText(emptyComposer(), "hi👍!");
    state = deleteBackward(state);
    expect(state.text).toBe("hi👍");
    state = deleteBackward(state);
    expect(state.text).toBe("hi");
  });

  it("removes a ZWJ emoji sequence in one backspace, not one code point", () => {
    let state = setComposerText(emptyComposer(), "hi👨‍👩‍👧‍👦");
    state = deleteBackward(state);
    expect(state.text).toBe("hi");
    expect(state.cursor).toBe(2);
  });

  it("removes a skin-tone modifier and its base together", () => {
    let state = setComposerText(emptyComposer(), "ok👍🏽");
    state = deleteBackward(state);
    expect(state.text).toBe("ok");
  });

  it("removes a combining mark with its base character", () => {
    // "e" + U+0301 combining acute — one cluster, one backspace.
    let state = setComposerText(emptyComposer(), "café");
    state = deleteBackward(state);
    expect(state.text).toBe("caf");
  });

  it("deletes forward by whole grapheme clusters too", () => {
    let state = setComposerText(emptyComposer(), "👨‍👩‍👧‍👦ok");
    state = moveCursorTo(state, 0);
    state = deleteForward(state);
    expect(state.text).toBe("ok");
    expect(state.cursor).toBe(0);
  });

  it("inserts multiline/bracketed paste without submitting on the first newline", () => {
    let state = emptyComposer();
    const pasted = "line1\nline2\nline3";
    const applied = applyInputChunk(state, pasted, { return: false });
    expect(applied.submit).toBe(false);
    expect(applied.state.text).toBe(pasted);
    expect(applied.state.cursor).toBe(pasted.length);
    // Lone Enter still submits.
    const enter = applyInputChunk(applied.state, "", { return: true });
    expect(enter.submit).toBe(true);
    expect(enter.state.text).toBe(pasted);
  });

  it("does not discard paste suffix after an embedded newline", () => {
    const state = emptyComposer();
    const applied = applyInputChunk(state, "first\nsecond\nthird", { return: false });
    expect(applied.state.text).toBe("first\nsecond\nthird");
    expect(applied.submit).toBe(false);
  });

  it("treats a single-line chunk ending with CR as submit (Ink whole-line entry)", () => {
    const state = emptyComposer();
    const applied = applyInputChunk(state, "/status\r", { return: false });
    expect(applied.submit).toBe(true);
    expect(applied.state.text).toBe("/status");
  });

  it("walks prompt history up and down", () => {
    let state = rememberSubmission(emptyComposer(), "one");
    state = rememberSubmission(state, "two");
    state = historyUp(state);
    expect(state.text).toBe("two");
    state = historyUp(state);
    expect(state.text).toBe("one");
    state = historyDown(state);
    expect(state.text).toBe("two");
    state = historyDown(state);
    expect(state.text).toBe("");
  });

  it("queues input while busy and restores it for edit", () => {
    let state = setComposerText(emptyComposer(), "follow up");
    state = queueWhileBusy(state, "follow up");
    expect(state.queue).toBe("follow up");
    expect(state.text).toBe("");
    state = loadQueueIntoDraft(state);
    expect(state.queue).toBeUndefined();
    expect(state.text).toBe("follow up");
  });

  it("parseBusySubmitIntent distinguishes follow-up, hard, and soft", () => {
    expect(parseBusySubmitIntent(">> later")).toEqual({ kind: "follow_up", text: "later" });
    expect(parseBusySubmitIntent("!stop")).toEqual({ kind: "hard", text: "stop" });
    expect(parseBusySubmitIntent("redirect")).toEqual({ kind: "soft", text: "redirect" });
    expect(parseBusySubmitIntent(">>")).toBeUndefined();
    expect(parseBusySubmitIntent("!")).toBeUndefined();
  });

  it("inserts newline on Shift+Enter without submitting", () => {
    const state = setComposerText(emptyComposer(), "line1");
    const applied = applyInputChunk(state, "", { return: true, shift: true });
    expect(applied.submit).toBe(false);
    expect(applied.state.text).toBe("line1\n");
    expect(applied.state.cursor).toBe(6);
  });

  it("deletes forward with delete key semantics", () => {
    let state = setComposerText(emptyComposer(), "abcd", 1);
    state = deleteForward(state);
    expect(state.text).toBe("acd");
    expect(state.cursor).toBe(1);
  });

  it("moves cursor across lines in a multiline draft", () => {
    let state = setComposerText(emptyComposer(), "aa\nbb", 1);
    state = moveCursorLine(state, 1);
    expect(state.cursor).toBe(4);
    state = moveCursorLine(state, -1);
    expect(state.cursor).toBe(1);
  });

  it("moves the cursor word-by-word left and right", () => {
    let state = setComposerText(emptyComposer(), "fix src/tui bug", 16);
    state = moveCursorWord(state, -1);
    expect(state.text.slice(0, state.cursor)).toBe("fix src/tui ");
    state = moveCursorWord(state, -1);
    expect(state.text.slice(0, state.cursor)).toBe("fix src/");
    state = moveCursorWord(state, -1);
    expect(state.text.slice(0, state.cursor)).toBe("fix src");
    state = moveCursorWord(state, -1);
    expect(state.text.slice(0, state.cursor)).toBe("fix ");
    state = moveCursorWord(state, 1);
    expect(state.text.slice(0, state.cursor)).toBe("fix src");
    state = moveCursorWord(state, 1);
    expect(state.text.slice(0, state.cursor)).toBe("fix src/");
    state = moveCursorWord(state, 1);
    expect(state.text.slice(0, state.cursor)).toBe("fix src/tui");
    state = moveCursorWord(state, 1);
    expect(state.cursor).toBe(state.text.length);
  });

  it("treats punctuation runs as words and skips whitespace", () => {
    let state = setComposerText(emptyComposer(), "a->b  c", 7);
    // cursor after "c" — the word run before it stops at the whitespace.
    state = moveCursorWord(state, -1);
    expect(state.text.slice(0, state.cursor)).toBe("a->b  ");
    state = moveCursorWord(state, -1);
    expect(state.text.slice(0, state.cursor)).toBe("a->");
    // punctuation run "->" is its own word; then "a".
    state = moveCursorWord(state, -1);
    expect(state.text.slice(0, state.cursor)).toBe("a");
    state = moveCursorWord(state, -1);
    expect(state.cursor).toBe(0);
    state = moveCursorWord(state, 1);
    expect(state.text.slice(0, state.cursor)).toBe("a");
    state = moveCursorWord(state, 1);
    expect(state.text.slice(0, state.cursor)).toBe("a->");
    state = moveCursorWord(state, 1);
    expect(state.text.slice(0, state.cursor)).toBe("a->b");
    state = moveCursorWord(state, 1);
    expect(state.cursor).toBe(7);
  });

  it("deletes the word left of the cursor", () => {
    let state = setComposerText(emptyComposer(), "fix the bug", 8);
    state = deleteWordBackward(state);
    expect(state.text).toBe("fix bug");
    expect(state.cursor).toBe(4);
    state = deleteWordBackward(state);
    expect(state.text).toBe("bug");
  });

  it("deletes the word right of the cursor, keeping separator whitespace", () => {
    let state = setComposerText(emptyComposer(), "fix the bug", 4);
    state = deleteWordForward(state);
    expect(state.text).toBe("fix  bug");
    expect(state.cursor).toBe(4);
  });

  it("kills the draft from the line start to the cursor", () => {
    let state = setComposerText(emptyComposer(), "hello world", 5);
    state = killToCursor(state);
    expect(state.text).toBe(" world");
    expect(state.cursor).toBe(0);
    // Cursor at line start: kill is a no-op.
    expect(killToCursor(state)).toBe(state);
  });

  it("slices viewer windows for scrollable overlays", () => {
    const lines = ["a", "b", "c", "d", "e"];
    expect(sliceViewerWindow(lines, 2, 0)).toMatchObject({
      visible: ["a", "b"],
      offset: 0,
      indicator: "lines 1–2/5",
    });
    expect(sliceViewerWindow(lines, 2, 3)).toMatchObject({
      visible: ["d", "e"],
      offset: 3,
      maxOffset: 3,
    });
  });
});
