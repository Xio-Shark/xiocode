import { describe, expect, it } from "vitest";

import {
  CACHE_COLD_PROVIDER_API,
  DEFAULT_CACHE_COLD_SECS,
  ProviderCacheColdTracker,
} from "./cache-cold.ts";

const T0 = 1_000_000;
const ANTHROPIC = CACHE_COLD_PROVIDER_API;

describe("ProviderCacheColdTracker", () => {
  it("defaults the cold threshold to 300s", () => {
    expect(DEFAULT_CACHE_COLD_SECS).toBe(300);
  });

  it("warns when a miss follows a hit after the cold threshold", () => {
    const tracker = new ProviderCacheColdTracker(300);
    // First response is a cache hit → warm.
    expect(tracker.observe({ providerApi: ANTHROPIC, cacheTokens: 1200, now: T0 })).toBeUndefined();
    // Next response is a miss 400s later → cache went cold.
    const warning = tracker.observe({ providerApi: ANTHROPIC, cacheTokens: 0, now: T0 + 400_000 });
    expect(warning).toEqual({ sinceLastHitSecs: 400, coldSecs: 300 });
  });

  it("does not warn when the miss is within the threshold (still warm)", () => {
    const tracker = new ProviderCacheColdTracker(300);
    tracker.observe({ providerApi: ANTHROPIC, cacheTokens: 1200, now: T0 });
    // Miss 100s later — under 300s, cache is still expected warm.
    expect(
      tracker.observe({ providerApi: ANTHROPIC, cacheTokens: 0, now: T0 + 100_000 }),
    ).toBeUndefined();
  });

  it("does not warn before any cache activity has been observed", () => {
    const tracker = new ProviderCacheColdTracker(300);
    // First-ever response is a miss — no prior hit to go cold.
    expect(
      tracker.observe({ providerApi: ANTHROPIC, cacheTokens: 0, now: T0 + 10_000_000 }),
    ).toBeUndefined();
  });

  it("de-noises repeated misses: warns once, then waits for a fresh hit", () => {
    const tracker = new ProviderCacheColdTracker(300);
    tracker.observe({ providerApi: ANTHROPIC, cacheTokens: 900, now: T0 });
    const first = tracker.observe({ providerApi: ANTHROPIC, cacheTokens: 0, now: T0 + 400_000 });
    expect(first).toBeDefined();
    // Second consecutive miss must not re-warn from the same stale gap.
    expect(
      tracker.observe({ providerApi: ANTHROPIC, cacheTokens: 0, now: T0 + 800_000 }),
    ).toBeUndefined();
    // A fresh hit re-arms the tracker.
    tracker.observe({ providerApi: ANTHROPIC, cacheTokens: 700, now: T0 + 900_000 });
    expect(
      tracker.observe({ providerApi: ANTHROPIC, cacheTokens: 0, now: T0 + 1_400_000 }),
    ).toBeDefined();
  });

  it("ignores non-Anthropic providers", () => {
    const tracker = new ProviderCacheColdTracker(300);
    tracker.observe({ providerApi: "openai-completions", cacheTokens: 500, now: T0 });
    expect(
      tracker.observe({ providerApi: "openai-completions", cacheTokens: 0, now: T0 + 999_000 }),
    ).toBeUndefined();
  });

  it("disables warnings when the threshold is 0", () => {
    const tracker = new ProviderCacheColdTracker(0);
    tracker.observe({ providerApi: ANTHROPIC, cacheTokens: 500, now: T0 });
    expect(
      tracker.observe({ providerApi: ANTHROPIC, cacheTokens: 0, now: T0 + 999_000 }),
    ).toBeUndefined();
  });
});
