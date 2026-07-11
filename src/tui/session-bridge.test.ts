import { describe, expect, it } from "vitest";

import { TuiSessionBridge } from "./session-bridge.ts";

describe("TuiSessionBridge", () => {
  it("resolves an interactive confirmation with the latest diff context", async () => {
    const bridge = new TuiSessionBridge();
    const events: unknown[] = [];
    bridge.subscribe((event) => events.push(event));
    bridge.sink.notify?.("diff --git a/a.ts b/a.ts");

    const answer = bridge.ask("Merge changes?");
    expect(bridge.confirmPending).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "confirm-open",
      question: "Merge changes?",
      detail: "diff --git a/a.ts b/a.ts",
    }));
    bridge.answerConfirmation(false);

    await expect(answer).resolves.toBe(false);
    expect(bridge.confirmPending).toBe(false);
  });

  it("keeps bypass session-local and audits auto-approval", async () => {
    const bridge = new TuiSessionBridge();
    const notices: string[] = [];
    bridge.subscribe((event) => {
      if (event.kind === "notice") notices.push(event.text);
    });

    expect(bridge.bypass).toBe(false);
    expect(bridge.toggleBypass()).toBe(true);
    await expect(bridge.ask("Merge changes?")).resolves.toBe(true);
    expect(notices.join("\n")).toContain("Bypass enabled");
    expect(notices.join("\n")).toContain("Bypass auto-approved");
    expect(bridge.toggleBypass()).toBe(false);
    const confirmation = bridge.ask("Merge after disable?");
    expect(bridge.confirmPending).toBe(true);
    bridge.answerConfirmation(false);
    await expect(confirmation).resolves.toBe(false);
    expect(new TuiSessionBridge().bypass).toBe(false);
  });
});
