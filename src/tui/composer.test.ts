import { describe, expect, it } from "vitest";

import {
  applyInputChunk,
  deleteBackward,
  emptyComposer,
  historyDown,
  historyUp,
  insertAtCursor,
  loadQueueIntoDraft,
  moveCursor,
  queueWhileBusy,
  rememberSubmission,
  setComposerText,
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
});
