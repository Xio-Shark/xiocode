import { describe, expect, it } from "vitest";

import { createStdoutSessionUiSink } from "./session-ui.ts";

describe("createStdoutSessionUiSink", () => {
  it("preserves streaming, tool, status, and cancellation output", () => {
    const chunks: string[] = [];
    const sink = createStdoutSessionUiSink((chunk) => chunks.push(chunk));

    sink.setStatus?.("sandbox", "clean");
    sink.onAssistantDelta?.("hel");
    sink.onAssistantDelta?.("lo");
    sink.onAssistantText?.("hello");
    sink.onToolStart?.({ id: "1", name: "read", arguments: { path: "README.md" } });
    sink.onCancelled?.();

    expect(chunks.join("")).toContain("[status:sandbox] clean");
    expect(chunks.join("")).toContain("hello");
    expect(chunks.join("")).toContain("> read");
    expect(chunks.join("")).toContain("(cancelled)");
  });
});
