import { describe, expect, it } from "vitest";

import { writeUsageSummary } from "./session.ts";

import type { PreparedSession } from "./session.ts";
import type { SessionCostSummary } from "./pricing.ts";

type SummarySession = Pick<PreparedSession, "getCostSummary" | "getModel">;

function session(summary: SessionCostSummary, model = "deepseek-chat"): SummarySession {
  return {
    getCostSummary: () => summary,
    getModel: () => ({ provider: "deepseek", id: model, name: model }),
  };
}

function capture(): { write: (chunk: string) => void; text: () => string } {
  const chunks: string[] = [];
  return { write: (chunk) => void chunks.push(chunk), text: () => chunks.join("") };
}

describe("writeUsageSummary (`xio -p` footer)", () => {
  it("prints a real dollar figure with the model that produced it", () => {
    const out = capture();
    writeUsageSummary(session({ totalTokens: 11_000, costUsd: 0.0042, hasUnpriced: false }), out.write);

    expect(out.text()).toContain("tok:11.0k $0.0042");
    expect(out.text()).toContain("deepseek/deepseek-chat");
    expect(out.text()).not.toContain("add [pricing");
  });

  it("says ~unknown and how to fix it when the model has no price", () => {
    const out = capture();
    writeUsageSummary(
      session({ totalTokens: 11_000, costUsd: null, hasUnpriced: true }, "private-model"),
      out.write,
    );

    expect(out.text()).toContain("~unknown");
    expect(out.text()).not.toContain("$0.00");
    expect(out.text()).toContain("[pricing.\"<model>\"]");
  });

  it("flags a partially priced session so the number is not read as the full bill", () => {
    const out = capture();
    writeUsageSummary(session({ totalTokens: 11_000, costUsd: 0.02, hasUnpriced: true }), out.write);

    expect(out.text()).toContain("$0.020+");
    expect(out.text()).toContain("no price for this model");
  });

  it("stays silent when the session never reached a provider", () => {
    const out = capture();
    writeUsageSummary(session({ totalTokens: 0, costUsd: null, hasUnpriced: false }), out.write);
    expect(out.text()).toBe("");
  });
});
