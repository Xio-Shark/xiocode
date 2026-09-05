import { readFile } from "node:fs/promises";

import type { PriceTable, UsageMetrics } from "./types.ts";

export async function loadPriceTable(filePath: string | undefined): Promise<PriceTable | undefined> {
  if (!filePath) {
    return undefined;
  }
  return decodePriceTable(JSON.parse(await readFile(filePath, "utf8")) as unknown);
}

export function estimateUsageCost(
  usage: UsageMetrics,
  provider: string | null,
  model: string | null,
  table: PriceTable | undefined,
): UsageMetrics {
  if (!provider || !model || !table) {
    return usage;
  }
  const price = table.models[`${provider}/${model}`];
  const counts = [usage.input_tokens, usage.output_tokens, usage.cache_tokens, usage.reasoning_tokens] as const;
  if (!price || counts.some((value) => value === null)) {
    return usage;
  }
  const uncachedInput = counts[0]! - counts[2]!;
  const nonReasoningOutput = counts[1]! - counts[3]!;
  if (uncachedInput < 0 || nonReasoningOutput < 0) {
    return usage;
  }
  const cost = (
    uncachedInput * price.input_per_million
    + nonReasoningOutput * price.output_per_million
    + counts[2]! * price.cache_per_million
    + counts[3]! * price.reasoning_per_million
  ) / 1_000_000;
  return { ...usage, estimated_cost_usd: cost };
}

export function decodePriceTable(value: unknown): PriceTable {
  const table = asRecord(value, "price table");
  if (table.schema_version !== "xio-eval-price-table.v1" || typeof table.version !== "string") {
    throw new Error("unsupported or invalid eval price table");
  }
  const models = asRecord(table.models, "price table models");
  for (const [name, rawPrice] of Object.entries(models)) {
    const price = asRecord(rawPrice, `price table model ${name}`);
    for (const field of ["input_per_million", "output_per_million", "cache_per_million", "reasoning_per_million"]) {
      if (typeof price[field] !== "number" || price[field] < 0 || !Number.isFinite(price[field])) {
        throw new Error(`invalid ${field} for price table model ${name}`);
      }
    }
  }
  return value as PriceTable;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
