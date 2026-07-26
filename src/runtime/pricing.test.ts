import { describe, expect, it } from "vitest";

import {
  createSessionCostMeter,
  estimateUsageCostUsd,
  formatCostUsd,
  formatSessionCost,
  formatUsageCostLabel,
  resolveModelPrice,
} from "./pricing.ts";

import type { TokenUsage } from "./types.ts";

function usage(input: number, output: number, cache = 0): TokenUsage {
  return { inputTokens: input, outputTokens: output, cacheTokens: cache, reasoningTokens: null };
}

describe("resolveModelPrice", () => {
  it("matches dated model ids to their family row", () => {
    expect(resolveModelPrice("claude-sonnet-4-20250514")?.outputPerMTok).toBe(15);
    expect(resolveModelPrice("DeepSeek-Chat")?.inputPerMTok).toBe(0.27);
  });

  it("returns undefined for unknown models rather than a zero price", () => {
    expect(resolveModelPrice("some-private-gateway-model")).toBeUndefined();
  });

  it("prefers overrides, and provider-qualified keys over bare model keys", () => {
    const overrides = {
      "gpt-4o": { inputPerMTok: 1, outputPerMTok: 2 },
      "acme/gpt-4o": { inputPerMTok: 9, outputPerMTok: 9 },
    };
    expect(resolveModelPrice("gpt-4o", { overrides })?.inputPerMTok).toBe(1);
    expect(resolveModelPrice("gpt-4o", { provider: "acme", overrides })?.inputPerMTok).toBe(9);
  });
});

describe("estimateUsageCostUsd", () => {
  it("bills cache reads at the cache rate and the remainder at the input rate", () => {
    const price = { inputPerMTok: 1, outputPerMTok: 10, cachePerMTok: 0.1 };
    // 1M input of which 800k cached → 200k * $1 + 800k * $0.1 = 0.2 + 0.08
    expect(estimateUsageCostUsd(usage(1_000_000, 0, 800_000), price)).toBeCloseTo(0.28, 10);
  });

  it("falls back to the input rate when no cache rate is set", () => {
    const price = { inputPerMTok: 2, outputPerMTok: 0 };
    expect(estimateUsageCostUsd(usage(1_000_000, 0, 500_000), price)).toBeCloseTo(2, 10);
  });

  it("clamps cache tokens to the reported input total", () => {
    const price = { inputPerMTok: 1, outputPerMTok: 0, cachePerMTok: 0 };
    expect(estimateUsageCostUsd(usage(100, 0, 5_000), price)).toBe(0);
  });

  it("returns null when the provider omitted a token count", () => {
    const price = { inputPerMTok: 1, outputPerMTok: 1 };
    expect(estimateUsageCostUsd(
      { inputTokens: null, outputTokens: 10, cacheTokens: 0, reasoningTokens: null },
      price,
    )).toBeNull();
  });
});

describe("formatCostUsd", () => {
  it("keeps enough decimals for real per-turn numbers", () => {
    expect(formatCostUsd(0.0042)).toBe("$0.0042");
    expect(formatCostUsd(0.42)).toBe("$0.420");
    expect(formatCostUsd(4.2)).toBe("$4.20");
  });

  it("never renders real spend as $0.0000", () => {
    expect(formatCostUsd(0.000042)).toBe("<$0.0001");
    expect(formatCostUsd(0)).toBe("$0.00");
  });
});

describe("formatUsageCostLabel", () => {
  it("prices a known model", () => {
    // deepseek-chat: 10k fresh input @0.27/M + 1k output @1.1/M
    expect(formatUsageCostLabel(usage(10_000, 1_000), "deepseek-chat")).toBe("$0.0038");
  });

  it("reports ~unknown for a model with no price", () => {
    expect(formatUsageCostLabel(usage(10_000, 1_000), "private-model")).toBe("~unknown");
  });
});

describe("createSessionCostMeter", () => {
  it("accumulates tokens and cost across responses", () => {
    const meter = createSessionCostMeter();
    meter.add(usage(10_000, 1_000), "deepseek-chat");
    meter.add(usage(10_000, 1_000), "deepseek-chat");
    const summary = meter.summary();
    expect(summary.totalTokens).toBe(22_000);
    expect(summary.hasUnpriced).toBe(false);
    expect(formatSessionCost(summary)).toBe("$0.0076");
  });

  it("prices each response with the model that produced it", () => {
    const meter = createSessionCostMeter();
    meter.add(usage(1_000_000, 0), "deepseek-chat"); // $0.27
    meter.add(usage(1_000_000, 0), "gpt-4o"); // $2.50
    expect(meter.summary().costUsd).toBeCloseTo(2.77, 6);
  });

  it("flags unpriced responses instead of billing them as zero", () => {
    const meter = createSessionCostMeter();
    meter.add(usage(1_000_000, 0), "private-model");
    expect(meter.summary()).toEqual({ totalTokens: 1_000_000, costUsd: null, hasUnpriced: true });
    expect(formatSessionCost(meter.summary())).toBe("~unknown");
  });

  it("marks a partially priced session with a trailing +", () => {
    const meter = createSessionCostMeter();
    meter.add(usage(1_000_000, 0), "deepseek-chat");
    meter.add(usage(1_000_000, 0), "private-model");
    expect(formatSessionCost(meter.summary())).toBe("$0.270+");
  });

  it("honors config overrides for otherwise unknown models", () => {
    const meter = createSessionCostMeter({ "private-model": { inputPerMTok: 3, outputPerMTok: 6 } });
    meter.add(usage(1_000_000, 1_000_000), "private-model");
    expect(meter.summary()).toEqual({ totalTokens: 2_000_000, costUsd: 9, hasUnpriced: false });
  });
});
