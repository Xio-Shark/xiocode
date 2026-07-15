import type { PerfMetricSummary, PerfOutcome, PerfSpan } from "./types.ts";

export function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) {
    return null;
  }
  if (p <= 0) {
    return sortedAsc[0]!;
  }
  if (p >= 100) {
    return sortedAsc[sortedAsc.length - 1]!;
  }
  const rank = (p / 100) * (sortedAsc.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) {
    return sortedAsc[low]!;
  }
  const weight = rank - low;
  return sortedAsc[low]! * (1 - weight) + sortedAsc[high]! * weight;
}

export function summarizeWallMs(values: readonly number[], outcomes: readonly PerfOutcome[]): PerfMetricSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const outcomeCounts: Record<PerfOutcome, number> = {
    success: 0,
    failure: 0,
    timeout: 0,
    cancelled: 0,
  };
  for (const outcome of outcomes) {
    outcomeCounts[outcome] += 1;
  }
  return {
    count: values.length,
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    min_ms: sorted[0] ?? null,
    max_ms: sorted.length > 0 ? sorted[sorted.length - 1]! : null,
    outcomes: outcomeCounts,
  };
}

export function summarizeSpansByName(spans: readonly PerfSpan[]): Record<string, PerfMetricSummary> {
  const buckets = new Map<string, { walls: number[]; outcomes: PerfOutcome[] }>();
  for (const span of spans) {
    const key = span.name;
    const bucket = buckets.get(key) ?? { walls: [], outcomes: [] };
    bucket.walls.push(span.wall_ms);
    bucket.outcomes.push(span.outcome);
    buckets.set(key, bucket);
  }
  const metrics: Record<string, PerfMetricSummary> = {};
  for (const [name, bucket] of buckets) {
    metrics[name] = summarizeWallMs(bucket.walls, bucket.outcomes);
  }
  return metrics;
}

export function mergeMetricSummaries(
  left: Readonly<Record<string, PerfMetricSummary>>,
  right: Readonly<Record<string, PerfMetricSummary>>,
): Record<string, PerfMetricSummary> {
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  const merged: Record<string, PerfMetricSummary> = {};
  for (const name of names) {
    const a = left[name];
    const b = right[name];
    if (!a) {
      merged[name] = b!;
      continue;
    }
    if (!b) {
      merged[name] = a;
      continue;
    }
    // Re-summarize requires raw samples; for report build we recompute from samples instead.
    // Keep this as a last-resort combine of counts only when raw walls unavailable.
    const walls: number[] = [];
    const outcomes: PerfOutcome[] = [];
    for (const [outcome, count] of Object.entries(a.outcomes) as [PerfOutcome, number][]) {
      for (let i = 0; i < count; i += 1) {
        if (a.p50_ms !== null) walls.push(a.p50_ms);
        outcomes.push(outcome);
      }
    }
    for (const [outcome, count] of Object.entries(b.outcomes) as [PerfOutcome, number][]) {
      for (let i = 0; i < count; i += 1) {
        if (b.p50_ms !== null) walls.push(b.p50_ms);
        outcomes.push(outcome);
      }
    }
    merged[name] = summarizeWallMs(walls, outcomes);
  }
  return merged;
}
