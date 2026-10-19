import { describe, expect, it, vi } from "vitest";

import { captureBootDiagnostics } from "./boot-diagnostics.ts";

function fakeConsole() {
  return { warn: vi.fn() } as unknown as Pick<Console, "warn"> & { warn: ReturnType<typeof vi.fn> };
}

describe("captureBootDiagnostics", () => {
  it("buffers warnings instead of printing them during boot", () => {
    const target = fakeConsole();
    const capture = captureBootDiagnostics(target);
    target.warn("skills: skipping", { path: "/tmp/x" });
    expect(capture.take()).toEqual(['skills: skipping {"path":"/tmp/x"}']);
  });

  it("restores console.warn exactly once", () => {
    const target = fakeConsole();
    const original = target.warn;
    const capture = captureBootDiagnostics(target);
    capture.restore();
    capture.restore();
    expect(target.warn).toBe(original);
  });

  it("caps the buffer so a warning loop cannot grow without bound", () => {
    const target = fakeConsole();
    const capture = captureBootDiagnostics(target, 2);
    target.warn("a");
    target.warn("b");
    target.warn("c");
    expect(capture.take()).toEqual(["a", "b"]);
  });
});
