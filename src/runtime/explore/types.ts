import type { TokenUsage } from "../types.ts";

/**
 * Absolute hard ceiling: primary may never fan out more than this many parallel explores.
 * Live sessions usually use a lower policy cap (default 4; ultra 8+; user-high up to 16).
 */
export const MAX_EXPLORE_CONCURRENCY = 16;

/** Resolved explore worker identity + budgets (after config + session defaults). */
export type ResolvedExploreConfig = Readonly<{
  provider: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  maxConcurrency: number;
  maxOutputChars: number;
  allowBash: boolean;
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
