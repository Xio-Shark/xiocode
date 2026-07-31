import { describe, expect, it } from "vitest";

import {
  motionEnabled,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  spinnerFrameAt,
  STREAM_CURSOR,
} from "./motion.ts";

describe("spinnerFrameAt", () => {
  it("cycles frames on the shared interval and stays in phase for equal clocks", () => {
    expect(spinnerFrameAt(0)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrameAt(SPINNER_INTERVAL_MS)).toBe(SPINNER_FRAMES[1]);
    expect(spinnerFrameAt(SPINNER_INTERVAL_MS * SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]);
    // Same clock ⇒ same frame (header / live region / composer stay in phase).
    const now = Date.now();
    expect(spinnerFrameAt(now)).toBe(spinnerFrameAt(now));
  });

  it("every frame is a single terminal cell (no layout shift while spinning)", () => {
    for (const frame of SPINNER_FRAMES) {
      expect([...frame]).toHaveLength(1);
    }
    expect([...STREAM_CURSOR]).toHaveLength(1);
  });
});

describe("motionEnabled", () => {
  it("defaults on for normal terminals", () => {
    expect(motionEnabled({ TERM: "xterm-256color" })).toBe(true);
    expect(motionEnabled({})).toBe(true);
  });

  it("disables on dumb terminals and explicit opt-out", () => {
    expect(motionEnabled({ TERM: "dumb" })).toBe(false);
    expect(motionEnabled({ XIO_ANIMATION: "off" })).toBe(false);
    expect(motionEnabled({ XIO_ANIMATION: "none" })).toBe(false);
    expect(motionEnabled({ XIO_ANIMATION: "reduced" })).toBe(false);
    expect(motionEnabled({ XIO_ANIMATION: "OFF" })).toBe(false);
  });

  it("ignores unrelated values", () => {
    expect(motionEnabled({ XIO_ANIMATION: "on" })).toBe(true);
    expect(motionEnabled({ TERM: "xterm", XIO_ANIMATION: "" })).toBe(true);
  });
});
