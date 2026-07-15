import type { TokenUsage } from "../types.ts";

export const PERF_SPAN_SCHEMA = "xio-perf-span.v1" as const;
export const PERF_REPORT_SCHEMA = "xio-perf-report.v1" as const;

export type PerfOutcome = "success" | "failure" | "timeout" | "cancelled";

export type PerfSpanName =
  | "process_start"
  | "first_frame"
  | "prompt_ready"
  | "provider.request"
  | "provider.first_token"
  | "provider.completion"
  | "tool.batch"
  | "checkpoint.persist"
  | "tui.paint"
  | "subagent.dispatch"
  | "subagent.evidence_complete";

export const PERF_SPAN_NAMES: readonly PerfSpanName[] = [
  "process_start",
  "first_frame",
  "prompt_ready",
  "provider.request",
  "provider.first_token",
  "provider.completion",
  "tool.batch",
  "checkpoint.persist",
  "tui.paint",
  "subagent.dispatch",
  "subagent.evidence_complete",
] as const;

export type PerfAttrValue = string | number | boolean | null;

export type PerfSpan = Readonly<{
  schema_version: typeof PERF_SPAN_SCHEMA;
  name: PerfSpanName;
  span_id: string;
  parent_id?: string;
  trace_id: string;
  t0_ms: number;
  wall_ms: number;
  cpu_user_ms: number | null;
  cpu_system_ms: number | null;
  rss_bytes: number | null;
  outcome: PerfOutcome;
  usage?: TokenUsage;
  attrs?: Readonly<Record<string, PerfAttrValue>>;
  error_class?: string;
}>;

export type PerfMetricSummary = Readonly<{
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  min_ms: number | null;
  max_ms: number | null;
  outcomes: Readonly<Record<PerfOutcome, number>>;
}>;

export type PerfOverheadProbe = Readonly<{
  samples: number;
  median_span_cost_us: number;
  concern: boolean;
  note: string;
}>;

export type PerfReport = Readonly<{
  schema_version: typeof PERF_REPORT_SCHEMA;
  bench_id: string;
  created_at: string;
  package_version: string;
  node_version: string;
  platform: string;
  arch: string;
  iterations: number;
  fixtures: readonly string[];
  metrics: Readonly<Record<string, PerfMetricSummary>>;
  overhead: PerfOverheadProbe;
  notes: readonly string[];
}>;

export type PerfSample = Readonly<{
  fixture: string;
  iteration: number;
  spans: readonly PerfSpan[];
  outcome: PerfOutcome;
  error_class?: string;
  wall_ms: number;
}>;
