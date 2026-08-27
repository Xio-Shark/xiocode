import type { TokenUsage } from "./types.ts";

/**
 * Versioned price table (USD per 1M tokens). Built-in rows cover the provider
 * presets; users override or extend via `[pricing."model-id"]` in config.toml.
 * Unknown models must surface as `~unknown`, never as $0 or an empty field.
 */
export const PRICE_TABLE_VERSION = "2026-07-26";

export type ModelPrice = Readonly<{
  /** USD per 1M input (prompt) tokens. */
  inputPerMTok: number;
  /** USD per 1M output (completion) tokens; reasoning tokens bill as output. */
  outputPerMTok: number;
  /** USD per 1M cache-read tokens; falls back to inputPerMTok when absent. */
  cachePerMTok?: number;
}>;

export type PricingOverrides = Readonly<Record<string, ModelPrice>>;

/** Longest-match-first substring rows against the lowercased model id. */
const BUILTIN_PRICES: readonly (readonly [pattern: string, price: ModelPrice])[] = [
  ["deepseek-chat", { inputPerMTok: 0.27, outputPerMTok: 1.1, cachePerMTok: 0.07 }],
  ["deepseek-reasoner", { inputPerMTok: 0.55, outputPerMTok: 2.19, cachePerMTok: 0.14 }],
  ["gpt-4.1-mini", { inputPerMTok: 0.4, outputPerMTok: 1.6, cachePerMTok: 0.1 }],
  ["gpt-4.1-nano", { inputPerMTok: 0.1, outputPerMTok: 0.4, cachePerMTok: 0.025 }],
  ["gpt-4.1", { inputPerMTok: 2, outputPerMTok: 8, cachePerMTok: 0.5 }],
  ["gpt-4o-mini", { inputPerMTok: 0.15, outputPerMTok: 0.6, cachePerMTok: 0.075 }],
  ["gpt-4o", { inputPerMTok: 2.5, outputPerMTok: 10, cachePerMTok: 1.25 }],
  ["o4-mini", { inputPerMTok: 1.1, outputPerMTok: 4.4, cachePerMTok: 0.275 }],
  ["claude-opus-4", { inputPerMTok: 15, outputPerMTok: 75, cachePerMTok: 1.5 }],
  ["claude-sonnet-4", { inputPerMTok: 3, outputPerMTok: 15, cachePerMTok: 0.3 }],
  ["claude-haiku-4", { inputPerMTok: 0.8, outputPerMTok: 4, cachePerMTok: 0.08 }],
  ["claude-3-5-haiku", { inputPerMTok: 0.8, outputPerMTok: 4, cachePerMTok: 0.08 }],
  ["gemini-2.5-flash", { inputPerMTok: 0.3, outputPerMTok: 2.5, cachePerMTok: 0.075 }],
  ["gemini-2.5-pro", { inputPerMTok: 1.25, outputPerMTok: 10, cachePerMTok: 0.31 }],
  ["gemini-2.0-flash", { inputPerMTok: 0.1, outputPerMTok: 0.4, cachePerMTok: 0.025 }],
];

/**
 * Resolve a model's price. Overrides win over built-ins; override keys match
 * as exact model id or `provider/model`. Built-ins match by substring so dated
 * ids (`claude-sonnet-4-20250514`) hit their family row.
 */
export function resolveModelPrice(
  model: string,
  options: Readonly<{ provider?: string; overrides?: PricingOverrides }> = {},
): ModelPrice | undefined {
  const overrides = options.overrides;
  if (overrides) {
    const qualified = options.provider ? overrides[`${options.provider}/${model}`] : undefined;
    if (qualified) return qualified;
    const exact = overrides[model];
    if (exact) return exact;
  }
  const id = model.toLowerCase();
  for (const [pattern, price] of BUILTIN_PRICES) {
    if (id.includes(pattern)) return price;
  }
  return undefined;
}

/**
 * Estimate the USD cost of one normalized usage record. Returns null when the
 * usage is incomplete — callers must render null as unknown, not as zero.
 */
export function estimateUsageCostUsd(usage: TokenUsage, price: ModelPrice): number | null {
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  const cacheTokens = Math.min(usage.cacheTokens ?? 0, usage.inputTokens);
  const cacheRate = price.cachePerMTok ?? price.inputPerMTok;

  // Fine-grained Anthropic-style creation vs read:
  // cache_creation is billed at 1.25x base input cost, cache_read at cacheRate.
  if (usage.cacheCreationTokens != null && usage.cacheCreationTokens > 0) {
    const creationTokens = Math.min(usage.cacheCreationTokens, usage.inputTokens);
    const readTokens = Math.min(
      usage.cacheReadTokens ?? Math.max(0, cacheTokens - creationTokens),
      usage.inputTokens - creationTokens,
    );
    const regularInput = Math.max(0, usage.inputTokens - creationTokens - readTokens);
    return (regularInput * price.inputPerMTok
      + creationTokens * (price.inputPerMTok * 1.25)
      + readTokens * cacheRate
      + usage.outputTokens * price.outputPerMTok) / 1_000_000;
  }

  const freshInput = usage.inputTokens - cacheTokens;
  return (freshInput * price.inputPerMTok
    + cacheTokens * cacheRate
    + usage.outputTokens * price.outputPerMTok) / 1_000_000;
}

/**
 * `$0.0042`-style rendering: enough decimals to show small real numbers.
 * A nonzero cost below the last displayed digit renders as `<$0.0001` rather
 * than `$0.0000` — real spend must never be shown as zero.
 */
export function formatCostUsd(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.0001) return "<$0.0001";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/** Label for a single usage record: real dollars, or `~unknown` when unpriceable. */
export function formatUsageCostLabel(
  usage: TokenUsage,
  model: string,
  options: Readonly<{ provider?: string; overrides?: PricingOverrides }> = {},
): string {
  const price = resolveModelPrice(model, options);
  if (!price) return UNKNOWN_COST_LABEL;
  const cost = estimateUsageCostUsd(usage, price);
  return cost === null ? UNKNOWN_COST_LABEL : formatCostUsd(cost);
}

/** Shown instead of a dollar figure — never render an unpriced model as `$0`. */
export const UNKNOWN_COST_LABEL = "~unknown";

export type SessionCostSummary = Readonly<{
  /** Provider-reported input + output tokens across the session. */
  totalTokens: number;
  /** Sum over priced responses; null when nothing could be priced at all. */
  costUsd: number | null;
  /** At least one response used a model (or usage record) we could not price. */
  hasUnpriced: boolean;
}>;

export type SessionCostMeter = Readonly<{
  /** Fold one provider response into the running total. */
  add: (usage: TokenUsage, model: string, provider?: string) => void;
  summary: () => SessionCostSummary;
}>;

/**
 * Running session cost. Models can change mid-session (`/model`), so each
 * response is priced with the model that produced it. Unpriced responses are
 * counted in tokens and flagged — they are never silently billed as zero.
 */
export function createSessionCostMeter(overrides?: PricingOverrides): SessionCostMeter {
  let totalTokens = 0;
  let costUsd: number | null = null;
  let hasUnpriced = false;
  return {
    add(usage, model, provider) {
      totalTokens += Math.max(0, usage.inputTokens ?? 0) + Math.max(0, usage.outputTokens ?? 0);
      const price = resolveModelPrice(model, { provider, overrides });
      const cost = price ? estimateUsageCostUsd(usage, price) : null;
      if (cost === null) {
        hasUnpriced = true;
        return;
      }
      costUsd = (costUsd ?? 0) + cost;
    },
    summary: () => ({ totalTokens, costUsd, hasUnpriced }),
  };
}

/**
 * Session cost for the status row / `-p` footer. A trailing `+` marks that some
 * responses were unpriced, so the figure is a floor rather than the full bill.
 */
export function formatSessionCost(summary: SessionCostSummary): string {
  if (summary.costUsd === null) return UNKNOWN_COST_LABEL;
  return `${formatCostUsd(summary.costUsd)}${summary.hasUnpriced ? "+" : ""}`;
}
