import React from "react";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";

import {
  BootInputBuffer,
  BootShell,
  applyBootKeyForTest,
  bootConfirmationIntent,
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

  it("renders trust detail and routes allow without polluting the draft", async () => {
    const buffer = new BootInputBuffer();
    const answers: boolean[] = [];
    const instance = render(React.createElement(BootShell, {
      version: "1.2.3",
      cwd: "/tmp/project",
      status: "loading context…",
      readiness: "prompt_context",
      buffer,
      confirmation: {
        question: "Trust this project directory? [y/N]",
        detail: "cwd: /tmp/project",
      },
      onAnswerConfirmation: (approved) => answers.push(approved),
      captureInput: true,
    }));

    expect(instance.lastFrame()).toContain("Trust this project directory?");
    expect(instance.lastFrame()).toContain("cwd: /tmp/project");
    instance.stdin.write("x");
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("y");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answers).toEqual([true]);
    expect(buffer.snapshot()).toEqual({ text: "", pendingSubmit: false });
  });

  it("routes default deny and Ctrl+C interruption", async () => {
    expect(bootConfirmationIntent("n", {})).toBe("deny");
    expect(bootConfirmationIntent("", { return: true })).toBe("deny");
    expect(bootConfirmationIntent("", { escape: true })).toBe("deny");
    expect(bootConfirmationIntent("c", { ctrl: true })).toBe("interrupt");

    const buffer = new BootInputBuffer();
    const answers: boolean[] = [];
    let interrupted = false;
    const instance = render(React.createElement(BootShell, {
      version: "1.2.3",
      cwd: "/tmp/project",
      status: "loading context…",
      readiness: "prompt_context",
      buffer,
      confirmation: { question: "Trust?" },
      onAnswerConfirmation: (approved) => answers.push(approved),
      onInterrupt: () => {
        interrupted = true;
      },
      captureInput: true,
    }));

    instance.stdin.write("\x03");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(interrupted).toBe(true);
    expect(answers).toEqual([false]);
    expect(buffer.text).toBe("");
  });

  it("resumes normal draft buffering after the modal closes", async () => {
    const buffer = new BootInputBuffer();
    const common = {
      version: "1.2.3",
      cwd: "/tmp/project",
      status: "loading context…",
      readiness: "prompt_context" as const,
      buffer,
      captureInput: true,
    };
    const instance = render(React.createElement(BootShell, {
      ...common,
      confirmation: { question: "Trust?" },
    }));
    instance.stdin.write("ignored");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(buffer.text).toBe("");

    instance.rerender(React.createElement(BootShell, common));
    instance.stdin.write("draft\r");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(buffer.snapshot()).toEqual({ text: "draft", pendingSubmit: true });
  });
});
