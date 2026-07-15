import type { ComparisonDecision } from "./comparator.ts";
import type { GateManifest } from "./gate-manifest.ts";
import {
  comparePerformanceReports,
  compareTokenBudgets,
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

export function deriveAwareness(
  candidate: CandidateSummary,
  manifest: GateManifest | null,
): AwarenessSection {
  const gaps: string[] = [];
  // Without workspace-perception metrics on trials yet, surface task resolution only.
  const taskResolution = candidate.attempted === 0 ? null : candidate.resolved_rate;
  if (taskResolution === null) {
    gaps.push("no completed trials for awareness metrics");
  }
  if (!manifest) {
    gaps.push("gate manifest omitted; awareness thresholds not applied");
  }
  return {
    schema_version: "xio-eval-awareness.v1",
    evidence_coverage: null,
    overlap: null,
    task_resolution: taskResolution,
    gaps,
  };
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
