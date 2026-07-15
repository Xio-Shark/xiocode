import { readFile } from "node:fs/promises";

import type { MetricThreshold } from "./gate-manifest.ts";
import type { PerformanceSection, PerformanceMetricDelta } from "./types.ts";

export type PerfMetricLike = Readonly<{
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  min_ms: number | null;
  max_ms: number | null;
}>;

export type PerfReportLike = Readonly<{
  schema_version: string;
  bench_id: string;
  metrics: Readonly<Record<string, PerfMetricLike>>;
}>;

export type PerformanceCompareResult = Readonly<{
  section: PerformanceSection;
  hardRegressions: readonly string[];
  softRegressions: readonly string[];
  concerns: readonly string[];
  errors: readonly string[];
}>;

export async function loadPerfReport(filePath: string): Promise<PerfReportLike> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  return decodePerfReportLike(raw);
}

export function decodePerfReportLike(value: unknown): PerfReportLike {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("perf report must be an object");
  }
  const root = value as Record<string, unknown>;
  if (typeof root.schema_version !== "string" || !root.schema_version.includes("perf-report")) {
    throw new Error(`unsupported perf report schema: ${String(root.schema_version)}`);
  }
  if (typeof root.bench_id !== "string") {
    throw new Error("perf report bench_id must be a string");
  }
  if (!root.metrics || typeof root.metrics !== "object" || Array.isArray(root.metrics)) {
    throw new Error("perf report metrics must be an object");
  }
  const metrics: Record<string, PerfMetricLike> = {};
  for (const [name, metric] of Object.entries(root.metrics as Record<string, unknown>)) {
    metrics[name] = decodeMetric(metric, name);
  }
  return {
    schema_version: root.schema_version,
    bench_id: root.bench_id,
    metrics,
  };
}

export function comparePerformanceReports(
  before: PerfReportLike | null,
  candidate: PerfReportLike | null,
  thresholds: readonly MetricThreshold[],
): PerformanceCompareResult {
  const concerns: string[] = [];
  const errors: string[] = [];
  const hardRegressions: string[] = [];
  const softRegressions: string[] = [];
  const deltas: Record<string, PerformanceMetricDelta> = {};

  if (!before || !candidate) {
    if (!before && !candidate) {
      concerns.push("performance reports omitted; performance axis skipped");
    } else {
      errors.push("performance compare requires both --perf-before and --perf-candidate reports");
    }
    return {
      section: {
        schema_version: "xio-eval-performance.v1",
        before_bench_id: before?.bench_id ?? null,
        candidate_bench_id: candidate?.bench_id ?? null,
        deltas,
        hard_regressions: hardRegressions,
        soft_regressions: softRegressions,
      },
      hardRegressions,
      softRegressions,
      concerns,
      errors,
    };
  }

  for (const threshold of thresholds) {
    if (threshold.metric === "usage.total_tokens") {
      // Token budgets are applied from trial usage in gate-decision, not fixture walls.
      continue;
    }
    const beforeMetric = before.metrics[threshold.metric];
    const candidateMetric = candidate.metrics[threshold.metric];
    if (!beforeMetric || !candidateMetric) {
      const msg = `metric unavailable: ${threshold.metric}`;
      if (threshold.required) {
        errors.push(msg);
      } else {
        concerns.push(msg);
      }
      continue;
    }
    const delta = metricDelta(beforeMetric, candidateMetric);
    deltas[threshold.metric] = delta;
    applyLatencyThreshold(threshold, delta, hardRegressions, softRegressions);
  }

  return {
    section: {
      schema_version: "xio-eval-performance.v1",
      before_bench_id: before.bench_id,
      candidate_bench_id: candidate.bench_id,
      deltas,
      hard_regressions: hardRegressions,
      soft_regressions: softRegressions,
    },
    hardRegressions,
    softRegressions,
    concerns,
    errors,
  };
}

export function tokenTotalsFromUsage(usage: Readonly<{
  input_tokens: number | null;
  output_tokens: number | null;
}>): number | null {
  if (usage.input_tokens === null || usage.output_tokens === null) {
    return null;
  }
  return usage.input_tokens + usage.output_tokens;
}

export function compareTokenBudgets(
  beforeTotal: number | null,
  candidateTotal: number | null,
  threshold: MetricThreshold | undefined,
): Readonly<{ hard: string[]; soft: string[]; concerns: string[] }> {
  const hard: string[] = [];
  const soft: string[] = [];
  const concerns: string[] = [];
  if (!threshold) {
    return { hard, soft, concerns };
  }
  if (beforeTotal === null || candidateTotal === null) {
    if (threshold.required) {
      hard.push("usage.total_tokens unavailable");
    } else {
      concerns.push("usage.total_tokens unavailable");
    }
    return { hard, soft, concerns };
  }
  const delta = candidateTotal - beforeTotal;
  if (threshold.hard_token_regression !== undefined && delta > threshold.hard_token_regression) {
    hard.push(
      `usage.total_tokens hard regression +${delta} (budget ${threshold.hard_token_regression})`,
    );
  } else if (threshold.soft_token_regression !== undefined && delta > threshold.soft_token_regression) {
    soft.push(
      `usage.total_tokens soft regression +${delta} (budget ${threshold.soft_token_regression})`,
    );
  }
  return { hard, soft, concerns };
}

function applyLatencyThreshold(
  threshold: MetricThreshold,
  delta: PerformanceMetricDelta,
  hard: string[],
  soft: string[],
): void {
  const p95 = delta.delta_p95_ms;
  const p50 = delta.delta_p50_ms;
  if (p95 !== null && threshold.hard_p95_regression_ms !== undefined && p95 > threshold.hard_p95_regression_ms) {
    hard.push(
      `${threshold.metric} p95 hard regression +${p95.toFixed(1)}ms (budget ${threshold.hard_p95_regression_ms}ms)`,
    );
  } else if (p95 !== null && threshold.soft_p95_regression_ms !== undefined && p95 > threshold.soft_p95_regression_ms) {
    soft.push(
      `${threshold.metric} p95 soft regression +${p95.toFixed(1)}ms (budget ${threshold.soft_p95_regression_ms}ms)`,
    );
  }
  if (p50 !== null && threshold.hard_p50_regression_ms !== undefined && p50 > threshold.hard_p50_regression_ms) {
    hard.push(
      `${threshold.metric} p50 hard regression +${p50.toFixed(1)}ms (budget ${threshold.hard_p50_regression_ms}ms)`,
    );
  } else if (p50 !== null && threshold.soft_p50_regression_ms !== undefined && p50 > threshold.soft_p50_regression_ms) {
    soft.push(
      `${threshold.metric} p50 soft regression +${p50.toFixed(1)}ms (budget ${threshold.soft_p50_regression_ms}ms)`,
    );
  }
}

function metricDelta(before: PerfMetricLike, candidate: PerfMetricLike): PerformanceMetricDelta {
  return {
    before_p50_ms: before.p50_ms,
    candidate_p50_ms: candidate.p50_ms,
    before_p95_ms: before.p95_ms,
    candidate_p95_ms: candidate.p95_ms,
    delta_p50_ms: diffNullable(candidate.p50_ms, before.p50_ms),
    delta_p95_ms: diffNullable(candidate.p95_ms, before.p95_ms),
  };
}

function diffNullable(candidate: number | null, before: number | null): number | null {
  if (candidate === null || before === null) return null;
  return candidate - before;
}

function decodeMetric(value: unknown, name: string): PerfMetricLike {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`perf metric ${name} must be an object`);
  }
  const metric = value as Record<string, unknown>;
  return {
    count: typeof metric.count === "number" ? metric.count : 0,
    p50_ms: nullableNumber(metric.p50_ms),
    p95_ms: nullableNumber(metric.p95_ms),
    min_ms: nullableNumber(metric.min_ms),
    max_ms: nullableNumber(metric.max_ms),
  };
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("perf metric numeric fields must be finite numbers or null");
  }
  return value;
}
