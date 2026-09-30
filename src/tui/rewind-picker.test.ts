import { describe, expect, it } from "vitest";

import type { RewindPointView } from "../runtime/rewind.ts";
import {
  backRewindPicker,
  enterRewindPicker,
  moveRewindPicker,
  openRewindPicker,
  rewindModeOptions,
} from "./rewind-picker.ts";

const point = (index: number, overrides: Partial<RewindPointView> = {}): RewindPointView => ({
  index,
  at: "",
  prompt: `turn ${index}`,
  code: { available: true },
  conversation: { available: true },
  ...overrides,
});

describe("rewind picker", () => {
  it("lists newest first and runs the chosen point and mode", () => {
    let state = openRewindPicker([point(1), point(2), point(3)]);
    expect(state.points.map((p) => p.index)).toEqual([3, 2, 1]);
    state = moveRewindPicker(state, 1);
    const options = enterRewindPicker(state);
    if (!("state" in options)) throw new Error("expected the options stage");
    const moved = moveRewindPicker(options.state, 1);
    expect(enterRewindPicker(moved)).toEqual({ run: { index: 2, mode: "conversation" } });
    expect(backRewindPicker(moved)?.stage).toBe("point");
    expect(backRewindPicker(openRewindPicker([point(1)]))).toBeUndefined();
  });

  it("preselects the first runnable option and never runs an unavailable one", () => {
    const pruned = point(1, { code: { available: false, reason: "snapshot pruned" } });
    expect(rewindModeOptions(pruned).map((o) => o.unavailable)).toEqual(["snapshot pruned", undefined, "snapshot pruned"]);
    const options = enterRewindPicker(openRewindPicker([pruned]));
    if (!("state" in options)) throw new Error("expected the options stage");
    expect(options.state.modeIndex).toBe(1);
    const onUnavailable = moveRewindPicker(options.state, 1); // "files only"
    expect(enterRewindPicker(onUnavailable)).toEqual({ state: onUnavailable });
  });
});
