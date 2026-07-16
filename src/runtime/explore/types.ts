import type { TokenUsage } from "../types.ts";

/**
 * Absolute hard ceiling: primary may never fan out more than this many parallel explores.
 * Adaptive lanes: fast 0 · standard 2–4 · deep 4–8 · explicit_high ≤16.
 */
export const MAX_EXPLORE_CONCURRENCY = 16;

/**
 * Product wave soft token budget (input+output across workers).
 * Covers one standard/deep wave without runaway multi-wave sessions. `0` = unlimited.
 */
export const DEFAULT_EXPLORE_WAVE_MAX_TOKENS = 250_000;

/**
 * Product soft USD cost ceiling (orchestrator uses ~$1/M blended estimate).
 * Slightly looser than the token default so token budget trips first under typical usage.
 * `0` = unlimited.
 */
export const DEFAULT_EXPLORE_WAVE_MAX_COST_USD = 1;

/**
 * Product provider-pressure limiter: max explore worker *starts* per rolling 60s window.
 * Allows deep (≤8) plus a couple retries; blocks tight spawn loops. `0` = unlimited.
 */
export const DEFAULT_EXPLORE_MAX_STARTS_PER_MINUTE = 24;

/** Resolved explore worker identity + budgets (after config + session defaults). */
export type ResolvedExploreConfig = Readonly<{
  provider: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  maxConcurrency: number;
  maxOutputChars: number;
  allowBash: boolean;
  /**
   * Soft wave token budget across workers (0 = unlimited).
   * Product default: {@link DEFAULT_EXPLORE_WAVE_MAX_TOKENS}.
   */
  maxTokens: number;
  /**
   * Soft wave cost budget in USD (0 = unlimited).
   * Product default: {@link DEFAULT_EXPLORE_WAVE_MAX_COST_USD}.
   */
  maxCostUsd: number;
  /**
   * Max explore worker starts per rolling minute (0 = unlimited).
   * Product default: {@link DEFAULT_EXPLORE_MAX_STARTS_PER_MINUTE}.
   */
  maxStartsPerMinute: number;
  /** User/project preference for partitioning work across workers. */
  partitionHint?: string;
}>;

export type ExploreSubagentResult = Readonly<{
  provider: string;
  model: string;
  success: boolean;
  cancelled?: boolean;
  text: string;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  usage: TokenUsage;
  timedOut?: boolean;
  error?: string;
}>;
