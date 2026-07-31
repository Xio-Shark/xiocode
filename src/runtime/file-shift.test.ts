import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FileShiftRegistry } from "./file-shift.ts";

const P = (name: string): string => path.join(os.tmpdir(), "xio-file-shift", name);

describe("FileShiftRegistry", () => {
  it("reports a shift when a write lands on a path another context read", async () => {
    const registry = new FileShiftRegistry();
    await registry.markRead("explore-1", P("a.ts"));
    const readers = await registry.noteWrite("main", P("a.ts"));
    expect(readers).toEqual(["explore-1"]);
  });

  it("does not report when the writer is the only reader (same context)", async () => {
    const registry = new FileShiftRegistry();
    await registry.markRead("main", P("b.ts"));
    expect(await registry.noteWrite("main", P("b.ts"))).toEqual([]);
  });

  it("does not report when no context read the path", async () => {
    const registry = new FileShiftRegistry();
    expect(await registry.noteWrite("main", P("c.ts"))).toEqual([]);
  });

  it("de-duplicates repeated writes to the same path by the same writer", async () => {
    const registry = new FileShiftRegistry();
    await registry.markRead("explore-1", P("d.ts"));
    expect(await registry.noteWrite("main", P("d.ts"))).toEqual(["explore-1"]);
    // Second write by the same writer must not re-notify (no screen spam).
    expect(await registry.noteWrite("main", P("d.ts"))).toEqual([]);
  });

  it("clears all read/notify state", async () => {
    const registry = new FileShiftRegistry();
    await registry.markRead("explore-1", P("e.ts"));
    registry.clear();
    expect(await registry.noteWrite("main", P("e.ts"))).toEqual([]);
  });
});
