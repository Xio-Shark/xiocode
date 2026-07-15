import { describe, expect, it, vi } from "vitest";

import {
  consumeMouseScrollChunk,
  isMouseLeakChunk,
  partitionMouseInput,
  stripMouseLeak,
} from "./mouse-scroll.ts";

describe("consumeMouseScrollChunk", () => {
  it("maps SGR wheel up/down to scroll directions", () => {
    const events: Array<{ dir: string; steps: number }> = [];
    const onScroll = (dir: "up" | "down", steps: number) => {
      events.push({ dir, steps });
    };

    // wheel up
    expect(consumeMouseScrollChunk("\x1b[<64;10;5M", onScroll)).toBe(true);
    // wheel down
    expect(consumeMouseScrollChunk("\x1b[<65;10;5M", onScroll)).toBe(true);
    // residual without ESC (Ink peels ESC)
    expect(consumeMouseScrollChunk("[<64;38;20M", onScroll)).toBe(true);
    // non-mouse
    expect(consumeMouseScrollChunk("hello", onScroll)).toBe(false);

    expect(events).toEqual([
      { dir: "up", steps: 3 },
      { dir: "down", steps: 3 },
      { dir: "up", steps: 3 },
    ]);
  });

  it("handles multiple wheel events in one chunk", () => {
    const spy = vi.fn();
    consumeMouseScrollChunk("\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M", spy);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenNthCalledWith(1, "up", 3);
    expect(spy).toHaveBeenNthCalledWith(3, "down", 3);
  });
});

describe("stripMouseLeak / partitionMouseInput", () => {
  it("strips residual mouse dump that polluted the prompt", () => {
    const leaked = "[<64;38;20M[<64;38;20M[<65;38;20Mhello";
    expect(stripMouseLeak(leaked)).toBe("hello");
  });

  it("detects pure mouse leak chunks", () => {
    expect(isMouseLeakChunk("[<64;38;20M[<65;38;20M")).toBe(true);
    expect(isMouseLeakChunk("\x1b[<64;1;1M")).toBe(true);
    expect(isMouseLeakChunk("hello")).toBe(false);
    expect(isMouseLeakChunk("a[<64;1;1M")).toBe(false);
  });

  it("holds incomplete mouse prefixes across chunks", () => {
    const first = partitionMouseInput("\x1b[<64;1");
    expect(first.complete).toBe("");
    expect(first.forward).toBe("");
    expect(first.hold).toBe("\x1b[<64;1");

    const second = partitionMouseInput(first.hold + ";1M");
    expect(second.complete).toContain("64");
    expect(second.forward).toBe("");
    expect(second.hold).toBe("");
  });

  it("forwards normal typing while capturing wheel sequences", () => {
    const part = partitionMouseInput("hi\x1b[<64;2;3Mthere");
    expect(part.forward).toBe("hithere");
    expect(part.complete).toContain("64");
    expect(part.hold).toBe("");
  });

  it("does not let trackpad dump enter the prompt draft", () => {
    // Exact failure mode from TUI screenshot: residual SGR without ESC.
    const dump =
      "[<64;38;20M[<64;38;20M[<67;38;20M[<64;38;20M[<65;38;20M[<66;38;20M";
    const part = partitionMouseInput(dump);
    expect(part.forward).toBe("");
    expect(part.complete.length).toBeGreaterThan(0);
    expect(stripMouseLeak(dump)).toBe("");
    expect(isMouseLeakChunk(dump)).toBe(true);

    // Prompt draft path: user had typed "ok" then scrolled — keep draft only.
    expect(stripMouseLeak(`ok${dump}`)).toBe("ok");
    expect(stripMouseLeak(`${dump}ok`)).toBe("ok");
  });
});
