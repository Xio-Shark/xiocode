import type { ComparisonDecision } from "./comparator.ts";
import type { GateManifest } from "./gate-manifest.ts";
import {
  comparePerformanceReports,
  compareTokenBudgets,
  compareUsageAggregates,
  tokenTotalsFromUsage,
  type PerfReportLike,
  type PerformanceCompareResult,
} from "./performance-compare.ts";
import type {
  AwarenessSection,
  CandidateSummary,
  EvalStatus,
  GateSection,
  PrivateJoinSection,
  TrialReport,
} from "./types.ts";

export type AxisStatus = "pass" | "fail" | "concern" | "infra" | "skipped";

export type MultiAxisInput = Readonly<{
  capability: ComparisonDecision;
  before: CandidateSummary;
  candidate: CandidateSummary;
  manifest: GateManifest | null;
  beforePerf: PerfReportLike | null;
  candidatePerf: PerfReportLike | null;
  privateJoin?: PrivateJoinSection;
  awareness?: AwarenessSection | null;
}>;

export type MultiAxisDecision = ComparisonDecision & Readonly<{
  performance?: PerformanceCompareResult["section"];
  awareness?: AwarenessSection;
  private_join?: PrivateJoinSection;
  gate?: GateSection;
}>;

/**
 * Combine capability compare with optional performance / awareness / private evidence.
 * Priority: INFRA → safety/capability FAIL → performance hard FAIL → soft concerns → PASS.
 */
export function decideMultiAxis(input: MultiAxisInput): MultiAxisDecision {
  const axes: Record<string, AxisStatus> = {
    infrastructure: "pass",
    safety: "pass",
    capability: "pass",
    performance: "skipped",
    awareness: "skipped",
    private_join: input.privateJoin ? "pass" : "skipped",
  };

  if (input.capability.status === "INFRA_ERROR") {
    axes.infrastructure = "infra";
    return finalize({
      status: "INFRA_ERROR",
      pairedDeltas: input.capability.pairedDeltas,
      concerns: [...input.capability.concerns],
      errors: [...input.capability.errors],
      axes,
      manifest: input.manifest,
      performance: undefined,
      awareness: input.awareness ?? undefined,
      privateJoin: input.privateJoin,
    });
  }

  const concerns = [...input.capability.concerns];
  const errors = [...input.capability.errors];

  if (!input.before.safety_ok || !input.candidate.safety_ok || input.capability.errors.some((e) =>
    e.includes("safety"))) {
    axes.safety = "fail";
  }
  if (input.capability.errors.some((e) => e.includes("capability regression") || e.includes("stable capability"))) {
    axes.capability = "fail";
  }
  if (input.capability.status === "FAIL") {
    if (axes.safety !== "fail" && axes.capability !== "fail") {
      axes.capability = "fail";
    }
  }

  let performanceSection: PerformanceCompareResult["section"] | undefined;
  if (input.manifest && (input.beforePerf || input.candidatePerf || input.manifest.performance.thresholds.length > 0)) {
    const perf = comparePerformanceReports(
      input.beforePerf,
      input.candidatePerf,
      input.manifest.performance.thresholds,
    );
    performanceSection = perf.section;
    concerns.push(...perf.concerns);
    errors.push(...perf.errors);
    if (perf.hardRegressions.length > 0) {
      axes.performance = "fail";
      errors.push(...perf.hardRegressions.map((item) => `performance hard regression: ${item}`));
    } else if (perf.softRegressions.length > 0) {
      axes.performance = "concern";
      concerns.push(...perf.softRegressions.map((item) => `performance soft regression: ${item}`));
    } else if (input.beforePerf && input.candidatePerf) {
      axes.performance = "pass";
    } else {
      axes.performance = "skipped";
    }

    const tokenThreshold = input.manifest.performance.thresholds.find((row) => row.metric === "usage.total_tokens");
    const beforeTokens = averageTokenTotal(input.before.trials);
    const candidateTokens = averageTokenTotal(input.candidate.trials);
    const tokenResult = compareTokenBudgets(beforeTokens, candidateTokens, tokenThreshold);
    concerns.push(...tokenResult.concerns);
    if (tokenResult.hard.length > 0) {
      axes.performance = "fail";
      errors.push(...tokenResult.hard.map((item) => `performance hard regression: ${item}`));
    } else if (tokenResult.soft.length > 0) {
      if (axes.performance !== "fail") axes.performance = "concern";
      concerns.push(...tokenResult.soft.map((item) => `performance soft regression: ${item}`));
    }

    // Trial-side cache/cost aggregates (provider efficiency) when thresholds present.
    const usageAgg = compareUsageAggregates(
      averageUsageExtras(input.before.trials),
      averageUsageExtras(input.candidate.trials),
      input.manifest.performance.thresholds,
    );
    concerns.push(...usageAgg.concerns);
    if (usageAgg.hard.length > 0) {
      axes.performance = "fail";
      errors.push(...usageAgg.hard.map((item) => `performance hard regression: ${item}`));
    } else if (usageAgg.soft.length > 0) {
      if (axes.performance !== "fail") axes.performance = "concern";
      concerns.push(...usageAgg.soft.map((item) => `performance soft regression: ${item}`));
    }
  }

  const awareness = input.awareness ?? deriveAwareness(input.candidate, input.manifest);
  if (awareness) {
    const awarenessIssues = evaluateAwareness(awareness, input.manifest);
    if (awarenessIssues.hard.length > 0) {
      axes.awareness = "fail";
      errors.push(...awarenessIssues.hard);
    } else if (awarenessIssues.soft.length > 0) {
      axes.awareness = "concern";
      concerns.push(...awarenessIssues.soft);
    } else if (awareness.evidence_coverage !== null || awareness.overlap !== null) {
      axes.awareness = "pass";
    } else {
      // Optional metrics missing → skipped (gaps stay in section; not a hard/soft fail).
      axes.awareness = "skipped";
    }
  }

  if (input.privateJoin) {
    // Private join is evidence only; never auto-merge. Non-FIXED is a concern, not capability PASS.
    if (!input.privateJoin.all_fixed) {
      axes.private_join = "concern";
      concerns.push("private regression join incomplete (not all FIXED); never auto-merges");
    }
    if (input.privateJoin.auto_merge_authorized !== false) {
      errors.push("private_join.auto_merge_authorized must be false");
      axes.private_join = "fail";
    }
  }

  // Hard fail axes dominate.
  if (axes.safety === "fail" || axes.capability === "fail") {
    return finalize({
      status: "FAIL",
      pairedDeltas: input.capability.pairedDeltas,
      concerns: unique(concerns),
      errors: unique(errors.length > 0 ? errors : ["hard safety/capability gate failed"]),
      axes,
      manifest: input.manifest,
      performance: performanceSection,
      awareness: awareness ?? undefined,
      privateJoin: input.privateJoin,
    });
  }
  if (axes.performance === "fail" || axes.awareness === "fail" || axes.private_join === "fail") {
    return finalize({
      status: "FAIL",
      pairedDeltas: input.capability.pairedDeltas,
      concerns: unique(concerns),
      errors: unique(errors.length > 0 ? errors : ["hard multi-axis gate failed"]),
      axes,
      manifest: input.manifest,
      performance: performanceSection,
      awareness: awareness ?? undefined,
      privateJoin: input.privateJoin,
    });
  }

  if (errors.length > 0) {
    return finalize({
      status: "FAIL",
      pairedDeltas: input.capability.pairedDeltas,
      concerns: unique(concerns),
      errors: unique(errors),
      axes,
      manifest: input.manifest,
      performance: performanceSection,
      awareness: awareness ?? undefined,
      privateJoin: input.privateJoin,
    });
  }

  if (concerns.length > 0 || input.capability.status === "PASS_WITH_CONCERNS") {
    return finalize({
      status: "PASS_WITH_CONCERNS",
      pairedDeltas: input.capability.pairedDeltas,
      concerns: unique(concerns),
      errors: [],
      axes,
      manifest: input.manifest,
      performance: performanceSection,
      awareness: awareness ?? undefined,
      privateJoin: input.privateJoin,
    });
  }

  return finalize({
    status: "PASS",
    pairedDeltas: input.capability.pairedDeltas,
    concerns: [],
    errors: [],
    axes,
    manifest: input.manifest,
    performance: performanceSection,
    awareness: awareness ?? undefined,
    privateJoin: input.privateJoin,
  });
}

/**
 * Derive awareness from optional per-trial metrics (explore brief / perception product path).
 * Averages non-null evidence_coverage and overlap; never fabricates fixed null when data exists.
 */
export function deriveAwareness(
  candidate: CandidateSummary,
  manifest: GateManifest | null,
): AwarenessSection {
  const gaps: string[] = [];
  const taskResolution = candidate.attempted === 0 ? null : candidate.resolved_rate;
  if (taskResolution === null) {
    gaps.push("no completed trials for awareness metrics");
  }
  if (!manifest) {
    gaps.push("gate manifest omitted; awareness thresholds not applied");
  }

  const coverages: number[] = [];
  const overlaps: number[] = [];
  for (const trial of candidate.trials) {
    if (trial.outcome.status === "infra_error") continue;
    const metrics = trial.awareness ?? parseAwarenessFromConcerns(trial.evidence.concerns);
    if (!metrics) continue;
    if (typeof metrics.evidence_coverage === "number" && Number.isFinite(metrics.evidence_coverage)) {
      coverages.push(clamp01(metrics.evidence_coverage));
    }
    if (typeof metrics.overlap === "number" && Number.isFinite(metrics.overlap)) {
      overlaps.push(clamp01(metrics.overlap));
    }
  }

  const evidenceCoverage = coverages.length > 0 ? mean(coverages) : null;
  const overlap = overlaps.length > 0 ? mean(overlaps) : null;
  if (evidenceCoverage === null && overlap === null) {
    gaps.push("trial awareness metrics unavailable (coverage/overlap)");
  }

  return {
    schema_version: "xio-eval-awareness.v1",
    evidence_coverage: evidenceCoverage,
    overlap,
    task_resolution: taskResolution,
    gaps,
  };
}

/** Accept structured concern tags: awareness.evidence_coverage=0.8, awareness.overlap=0.1 */
export function parseAwarenessFromConcerns(
  concerns: readonly string[],
): Readonly<{ evidence_coverage: number | null; overlap: number | null }> | null {
  let evidence_coverage: number | null = null;
  let overlap: number | null = null;
  let found = false;
  for (const line of concerns) {
    const cov = line.match(/awareness\.evidence_coverage\s*=\s*([0-9.]+)/i);
    if (cov?.[1]) {
      const value = Number(cov[1]);
      if (Number.isFinite(value)) {
        evidence_coverage = value;
        found = true;
      }
    }
    const ov = line.match(/awareness\.overlap\s*=\s*([0-9.]+)/i);
    if (ov?.[1]) {
      const value = Number(ov[1]);
      if (Number.isFinite(value)) {
        overlap = value;
        found = true;
      }
    }
  }
  return found ? { evidence_coverage, overlap } : null;
}

function evaluateAwareness(
  awareness: AwarenessSection,
  manifest: GateManifest | null,
): Readonly<{ hard: string[]; soft: string[] }> {
  const hard: string[] = [];
  const soft: string[] = [];
  if (!manifest) return { hard, soft };
  const softOnly = manifest.awareness.soft_only;
  if (
    awareness.evidence_coverage !== null
    && manifest.awareness.min_evidence_coverage !== undefined
    && awareness.evidence_coverage < manifest.awareness.min_evidence_coverage
  ) {
    const msg = `evidence coverage ${awareness.evidence_coverage.toFixed(3)} below ${manifest.awareness.min_evidence_coverage}`;
    (softOnly ? soft : hard).push(msg);
  }
  if (
    awareness.overlap !== null
    && manifest.awareness.max_overlap !== undefined
    && awareness.overlap > manifest.awareness.max_overlap
  ) {
    const msg = `evidence overlap ${awareness.overlap.toFixed(3)} above ${manifest.awareness.max_overlap}`;
    (softOnly ? soft : hard).push(msg);
  }
  return { hard, soft };
}

function averageTokenTotal(trials: readonly TrialReport[]): number | null {
  const values: number[] = [];
  for (const trial of trials) {
    if (trial.outcome.status === "infra_error") continue;
    const total = tokenTotalsFromUsage(trial.usage);
    if (total !== null) values.push(total);
  }
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function averageUsageExtras(trials: readonly TrialReport[]): Readonly<{
  cache_tokens: number | null;
  cost_usd: number | null;
}> {
  const caches: number[] = [];
  const costs: number[] = [];
  for (const trial of trials) {
    if (trial.outcome.status === "infra_error") continue;
    if (trial.usage.cache_tokens !== null) caches.push(trial.usage.cache_tokens);
    if (trial.usage.estimated_cost_usd !== null) costs.push(trial.usage.estimated_cost_usd);
  }
  return {
    cache_tokens: caches.length > 0 ? mean(caches) : null,
    cost_usd: costs.length > 0 ? mean(costs) : null,
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function finalize(input: Readonly<{
  status: EvalStatus;
  pairedDeltas: Readonly<Record<string, number>>;
  concerns: readonly string[];
  errors: readonly string[];
  axes: Record<string, AxisStatus>;
  manifest: GateManifest | null;
  performance?: PerformanceCompareResult["section"];
  awareness?: AwarenessSection;
  privateJoin?: PrivateJoinSection;
}>): MultiAxisDecision {
  const gate: GateSection | undefined = input.manifest
    ? {
      schema_version: "xio-eval-gate.v1",
      manifest_id: input.manifest.id,
      manifest_version: input.manifest.version,
      axes: input.axes,
    }
    : undefined;
  return {
    status: input.status,
    pairedDeltas: input.pairedDeltas,
    concerns: input.concerns,
    errors: input.errors,
    performance: input.performance,
    awareness: input.awareness,
    private_join: input.privateJoin,
    gate,
  };
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}
