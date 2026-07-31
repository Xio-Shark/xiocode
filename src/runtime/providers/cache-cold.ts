/**
 * Provider prompt-cache cold detection (jcode-style cache-cost observability).
 *
 * Anthropic prompt caches expire after ~5 min of inactivity. When a session pauses longer
 * than the cold threshold, the next request silently pays full uncached input. This tracker
 * turns that silent cost into an observable `provider.cache_cold_warning` signal.
 *
 * It is a pure state machine (inject `now`) so it can be unit-tested with a fake clock, and
 * it does **not** issue keep-alive requests — it only reports, never burns tokens to stay warm.
 */

/** Anthropic default TTL for prompt caches is ~5 min. */
export const DEFAULT_CACHE_COLD_SECS = 300;

/** Only Anthropic-style prompt caches have this cold-expiry behavior today. */
export const CACHE_COLD_PROVIDER_API = "anthropic-messages";

export type CacheColdWarning = Readonly<{
  /** Seconds since the last observed cache activity (the gap that likely expired the cache). */
  sinceLastHitSecs: number;
  /** Configured cold threshold in seconds. */
  coldSecs: number;
}>;

export type ObserveInput = Readonly<{
  providerApi: string;
  /** Normalized cache tokens for the response (`cache_read + cache_creation` for Anthropic). */
  cacheTokens: number | null;
  /** Epoch millis for this observation (inject a fake clock in tests). */
  now: number;
}>;

/**
 * Tracks prompt-cache warmth across provider responses within one session.
 *
 * A warning fires when the current response paid full input (`cacheTokens` 0/null) **and**
 * the gap since the last cache activity exceeded the cold threshold. After warning, the
 * tracker waits for a fresh cache hit before it can warn again (de-noises repeated misses).
 */
export class ProviderCacheColdTracker {
  #lastCacheActivityAt: number | undefined;
  readonly #coldMs: number;

  constructor(coldSecs: number = DEFAULT_CACHE_COLD_SECS) {
    this.#coldMs = Math.max(0, coldSecs) * 1000;
  }

  /** @returns a warning when the cache likely went cold this turn, else undefined. */
  observe(input: ObserveInput): CacheColdWarning | undefined {
    // 0 disables; non-Anthropic providers do not have this cold-expiry contract.
    if (this.#coldMs <= 0 || input.providerApi !== CACHE_COLD_PROVIDER_API) {
      return undefined;
    }
    const hadCache = (input.cacheTokens ?? 0) > 0;
    let warning: CacheColdWarning | undefined;
    if (
      !hadCache
      && this.#lastCacheActivityAt !== undefined
      && input.now - this.#lastCacheActivityAt > this.#coldMs
    ) {
      warning = {
        sinceLastHitSecs: Math.round((input.now - this.#lastCacheActivityAt) / 1000),
        coldSecs: this.#coldMs / 1000,
      };
      // De-noise: require a fresh hit before warning again.
      this.#lastCacheActivityAt = undefined;
    }
    if (hadCache) {
      this.#lastCacheActivityAt = input.now;
    }
    return warning;
  }
}
