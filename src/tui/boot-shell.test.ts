import React from "react";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";

import {
  BootInputBuffer,
  BootShell,
  applyBootKeyForTest,
  readinessLabel,
} from "./boot-shell.ts";

describe("BootInputBuffer", () => {
  it("buffers typed characters and drains them", () => {
    const buffer = new BootInputBuffer();
    applyBootKeyForTest(buffer, "h");
    applyBootKeyForTest(buffer, "i");
    expect(buffer.snapshot()).toEqual({ text: "hi", pendingSubmit: false });
    const drained = buffer.drain();
    expect(drained).toEqual({ text: "hi", pendingSubmit: false });
    expect(buffer.snapshot()).toEqual({ text: "", pendingSubmit: false });
  });

  it("marks pendingSubmit on Enter with non-empty draft", () => {
    const buffer = new BootInputBuffer();
    applyBootKeyForTest(buffer, "go");
    applyBootKeyForTest(buffer, "", { return: true });
    expect(buffer.pendingSubmit).toBe(true);
    expect(buffer.text).toBe("go");
  });

  it("backspace edits the draft", () => {
    const buffer = new BootInputBuffer();
    applyBootKeyForTest(buffer, "ab");
    applyBootKeyForTest(buffer, "", { backspace: true });
    expect(buffer.text).toBe("a");
  });
});

describe("readinessLabel", () => {
  it("prefers explicit status while not ready", () => {
    expect(readinessLabel("boot", "starting…")).toBe("starting…");
    expect(readinessLabel("core_session", "loading session…")).toBe("loading session…");
    expect(readinessLabel("ready", "")).toBe("ready");
  });
});

describe("BootShell", () => {
  afterEach(() => cleanup());

  it("renders brand, cwd, and status without claiming ready", () => {
    const buffer = new BootInputBuffer();
    const { lastFrame } = render(React.createElement(BootShell, {
      version: "1.2.3",
      cwd: "/tmp/project",
      status: "starting…",
      readiness: "boot",
      buffer,
      captureInput: false,
    }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("XioCode v1.2.3");
    expect(frame).toMatch(/project|\/tmp/);
    expect(frame).toContain("starting");
    expect(frame).not.toMatch(/Starting… input is buffered/);
  });
});
