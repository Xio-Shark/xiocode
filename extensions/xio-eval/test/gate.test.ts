import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compareSummaries, summarizeCandidate } from "../src/comparator.ts";
import { decideMultiAxis } from "../src/gate-decision.ts";
import { decodeGateManifest, loadGateManifest } from "../src/gate-manifest.ts";
import { comparePerformanceReports, decodePerfReportLike } from "../src/performance-compare.ts";
import { decodeEvalReport, emptyUsage } from "../src/types.ts";
import { parseEvalArgs } from "../../../src/cli/eval-cli.ts";

import type { SafetyResult, TrialReport } from "../src/types.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("multi-axis evaluation gate", () => {
  it("loads the frozen default gate manifest", async () => {
    const manifest = await loadGateManifest();
    expect(manifest.schema_version).toBe("xio-eval-gate-manifest.v1");
    expect(manifest.id).toBe("default-gate");
    expect(manifest.performance.groups.startup).toContain("cli.version");
    expect(manifest.private_families).toContain("resume-failure");
    expect(manifest.capability.stable_regression_is_hard_fail).toBe(true);
  });

  it("rejects unknown gate manifest schemas", () => {
    expect(() => decodeGateManifest({ schema_version: "nope" })).toThrow(/unsupported gate manifest/);
  });

  it("fails capability regression even when performance improves", () => {
    const before = summarizeCandidate("before", "b1", [
      trial("local-bug-holdout", "local-bug", true),
      trial("cli-holdout", "cli-behavior", true),
    ]);
    const candidate = summarizeCandidate("candidate", "c1", [
      trial("local-bug-holdout", "local-bug", false),
      trial("cli-holdout", "cli-behavior", true),
    ]);
    const capability = compareSummaries(before, candidate);
    expect(capability.status).toBe("FAIL");

    const fastCandidate = decodePerfReportLike(perfReport("cand", {
      "fixture.cli.version.wall": metric(20, 30),
    }));
    const slowBefore = decodePerfReportLike(perfReport("before", {
      "fixture.cli.version.wall": metric(100, 150),
    }));
    const decision = decideMultiAxis({
      capability,
      before,
      candidate,
      manifest: mustManifest(),
      beforePerf: slowBefore,
      candidatePerf: fastCandidate,
    });
    expect(decision.status).toBe("FAIL");
    expect(decision.errors.some((item) => item.includes("capability regression"))).toBe(true);
    expect(decision.gate?.axes.capability).toBe("fail");
  });

  it("fails hard performance budgets even when capability improves", () => {
    const before = summarizeCandidate("before", "b1", [
      trial("local-bug-holdout", "local-bug", false),
    ]);
    const candidate = summarizeCandidate("candidate", "c1", [
      trial("local-bug-holdout", "local-bug", true),
    ]);
    const capability = compareSummaries(before, candidate);
    expect(capability.status === "PASS" || capability.status === "PASS_WITH_CONCERNS").toBe(true);

    const beforePerf = decodePerfReportLike(perfReport("before", {
      "fixture.cli.version.wall": metric(30, 40),
    }));
    const candidatePerf = decodePerfReportLike(perfReport("cand", {
      "fixture.cli.version.wall": metric(200, 300),
    }));
    const decision = decideMultiAxis({
      capability,
      before,
      candidate,
      manifest: mustManifest(),
      beforePerf,
      candidatePerf,
    });
    expect(decision.status).toBe("FAIL");
    expect(decision.errors.some((item) => item.includes("performance hard regression"))).toBe(true);
    expect(decision.gate?.axes.performance).toBe("fail");
    expect(decision.performance?.hard_regressions.length).toBeGreaterThan(0);
  });

  it("keeps infrastructure errors outside capability denominators and surfaces INFRA_ERROR", () => {
    const before = summarizeCandidate("before", "b1", [
      trial("local-bug-holdout", "local-bug", true, "infra_error"),
    ]);
    const candidate = summarizeCandidate("candidate", "c1", [
      trial("local-bug-holdout", "local-bug", true),
    ]);
    expect(before.attempted).toBe(0);
    expect(before.infra_errors).toBe(1);
    const capability = compareSummaries(before, candidate);
    expect(capability.status).toBe("INFRA_ERROR");
    const decision = decideMultiAxis({
      capability,
      before,
      candidate,
      manifest: mustManifest(),
      beforePerf: null,
      candidatePerf: null,
    });
    expect(decision.status).toBe("INFRA_ERROR");
    expect(decision.gate?.axes.infrastructure).toBe("infra");
  });

  it("joins private cases as evidence only with auto_merge_authorized false", () => {
    const before = summarizeCandidate("before", "b1", [trial("local-bug-holdout", "local-bug", false)]);
    const candidate = summarizeCandidate("candidate", "c1", [trial("local-bug-holdout", "local-bug", true)]);
    const capability = compareSummaries(before, candidate);
    const decision = decideMultiAxis({
      capability,
      before,
      candidate,
      manifest: mustManifest(),
      beforePerf: null,
      candidatePerf: null,
      privateJoin: {
        schema_version: "xio-eval-private-join.v1",
        cases: [
          { case_id: "abc", family: "resume-failure", status: "FIXED" },
          { case_id: "def", family: "startup-regression", status: "STILL_RED" },
        ],
        all_fixed: false,
        auto_merge_authorized: false,
      },
    });
    expect(decision.private_join?.auto_merge_authorized).toBe(false);
    expect(decision.private_join?.all_fixed).toBe(false);
    expect(decision.status).not.toBe("PASS");
    expect(decision.concerns.some((item) => item.includes("never auto-merges"))).toBe(true);
  });

  it("computes performance deltas from independent reports", () => {
    const before = decodePerfReportLike(perfReport("b", {
      "fixture.cli.version.wall": metric(50, 80),
    }));
    const candidate = decodePerfReportLike(perfReport("c", {
      "fixture.cli.version.wall": metric(40, 70),
    }));
    const result = comparePerformanceReports(before, candidate, [
      {
        metric: "fixture.cli.version.wall",
        hard_p95_regression_ms: 200,
        soft_p95_regression_ms: 50,
      },
    ]);
    expect(result.section.deltas["fixture.cli.version.wall"]?.delta_p50_ms).toBe(-10);
    expect(result.hardRegressions).toEqual([]);
  });

  it("parses multi-axis compare CLI flags", () => {
    const args = parseEvalArgs([
      "compare",
      "--before",
      "/tmp/before",
      "--candidate",
      "/tmp/cand",
      "--manifest",
      "gate.json",
      "--perf-before",
      "b.json",
      "--perf-candidate",
      "c.json",
      "--private-case",
      "case-a",
      "--private-case",
      "case-b",
    ]);
    expect(args).toMatchObject({
      command: "compare",
      beforeRoot: "/tmp/before",
      candidateRoot: "/tmp/cand",
      gateManifestPath: "gate.json",
      perfBeforePath: "b.json",
      perfCandidatePath: "c.json",
      privateCaseIds: ["case-a", "case-b"],
    });
  });

  it("rejects partial perf flags", () => {
    expect(() => parseEvalArgs([
      "compare",
      "--before",
      ".",
      "--candidate",
      ".",
      "--perf-before",
      "b.json",
    ])).toThrow(/both --perf-before and --perf-candidate/);
  });

  it("decodes reports with optional multi-axis sections", () => {
    const report = decodeEvalReport({
      schema_version: "xio-eval-report.v1",
      eval_id: "e1",
      series_id: "s1",
      mode: "compare",
      status: "PASS_WITH_CONCERNS",
      created_at: "2026-07-15T00:00:00.000Z",
      suite: {
        suite_id: "s",
        suite_version: "1",
        suite_sha: "a".repeat(64),
        evaluator_sha: "b".repeat(64),
      },
      candidates: [],
      paired_deltas: {},
      concerns: ["x"],
      errors: [],
      performance: {
        schema_version: "xio-eval-performance.v1",
        before_bench_id: "b",
        candidate_bench_id: "c",
        deltas: {
          "fixture.cli.version.wall": {
            before_p50_ms: 10,
            candidate_p50_ms: 12,
            before_p95_ms: 20,
            candidate_p95_ms: 25,
            delta_p50_ms: 2,
            delta_p95_ms: 5,
          },
        },
        hard_regressions: [],
        soft_regressions: [],
      },
      awareness: {
        schema_version: "xio-eval-awareness.v1",
        evidence_coverage: null,
        overlap: null,
        task_resolution: 1,
        gaps: [],
      },
      private_join: {
        schema_version: "xio-eval-private-join.v1",
        cases: [],
        all_fixed: true,
        auto_merge_authorized: false,
      },
      gate: {
        schema_version: "xio-eval-gate.v1",
        manifest_id: "default-gate",
        manifest_version: "1.0.0",
        axes: {
          infrastructure: "pass",
          safety: "pass",
          capability: "pass",
          performance: "pass",
          awareness: "skipped",
          private_join: "pass",
        },
      },
    });
    expect(report.gate?.manifest_id).toBe("default-gate");
    expect(report.private_join?.auto_merge_authorized).toBe(false);
  });

  it("writes independent perf fixtures for integration-style paths", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "xio-gate-"));
    const beforePath = path.join(dir, "before.json");
    const candidatePath = path.join(dir, "candidate.json");
    await writeFile(beforePath, JSON.stringify(perfReport("before", {
      "fixture.cli.version.wall": metric(30, 40),
    })), "utf8");
    await writeFile(candidatePath, JSON.stringify(perfReport("cand", {
      "fixture.cli.version.wall": metric(35, 45),
    })), "utf8");
    await mkdir(path.join(dir, "nested"), { recursive: true });
    expect(packageRoot.length).toBeGreaterThan(0);
  });

  it("populates awareness coverage/overlap from trial metrics (not fixed null)", () => {
    const before = summarizeCandidate("before", "b1", [
      trial("local-bug-holdout", "local-bug", false),
    ]);
    const candidateTrials = [
      withAwareness(trial("local-bug-holdout", "local-bug", true), 0.9, 0.2),
      withAwareness(trial("cli-holdout", "cli-behavior", true), 0.7, 0.3),
    ];
    const candidate = summarizeCandidate("candidate", "c1", candidateTrials);
    const capability = compareSummaries(before, candidate);
    const decision = decideMultiAxis({
      capability,
      before,
      candidate,
      manifest: mustManifest(),
      beforePerf: null,
      candidatePerf: null,
    });
    expect(decision.awareness?.evidence_coverage).toBeCloseTo(0.8, 5);
    expect(decision.awareness?.overlap).toBeCloseTo(0.25, 5);
    expect(decision.gate?.axes.awareness).toBe("pass");
  });

  it("flags low evidence coverage as awareness concern", () => {
    const before = summarizeCandidate("before", "b1", [trial("local-bug-holdout", "local-bug", false)]);
    const candidate = summarizeCandidate("candidate", "c1", [
      withAwareness(trial("local-bug-holdout", "local-bug", true), 0.2, 0.1),
    ]);
    const decision = decideMultiAxis({
      capability: compareSummaries(before, candidate),
      before,
      candidate,
      manifest: mustManifest(),
      beforePerf: null,
      candidatePerf: null,
    });
    expect(decision.gate?.axes.awareness).toBe("concern");
    expect(decision.concerns.some((item) => item.includes("evidence coverage"))).toBe(true);
  });

  it("compares RSS/CPU/cache/cost resource deltas on perf reports", () => {
    const before = decodePerfReportLike({
      ...perfReport("b", { "fixture.cli.version.wall": metric(30, 40) }),
      resource: {
        rss_bytes: 100_000_000,
        cpu_user_ms: 100,
        cpu_system_ms: 20,
        cache_tokens: 1000,
        cost_usd: 0.05,
      },
    });
    const candidate = decodePerfReportLike({
      ...perfReport("c", { "fixture.cli.version.wall": metric(28, 38) }),
      resource: {
        rss_bytes: 250_000_000,
        cpu_user_ms: 150,
        cpu_system_ms: 25,
        cache_tokens: 1200,
        cost_usd: 0.06,
      },
    });
    const result = comparePerformanceReports(before, candidate, [
      {
        metric: "fixture.cli.version.wall",
        hard_p95_regression_ms: 200,
      },
      {
        metric: "resource.rss_bytes",
        hard_absolute_regression: 50_000_000,
      },
      {
        metric: "resource.cpu_user_ms",
        soft_absolute_regression: 30,
      },
    ]);
    expect(result.section.resource?.delta_rss_bytes).toBe(150_000_000);
    expect(result.hardRegressions.some((item) => item.includes("resource.rss_bytes"))).toBe(true);
    expect(result.softRegressions.some((item) => item.includes("resource.cpu_user_ms"))).toBe(true);
  });

  it("hard-fails required missing latency metrics when perf reports present", () => {
    const before = summarizeCandidate("before", "b1", [trial("local-bug-holdout", "local-bug", false)]);
    const candidate = summarizeCandidate("candidate", "c1", [trial("local-bug-holdout", "local-bug", true)]);
    const capability = compareSummaries(before, candidate);
    const beforePerf = decodePerfReportLike(perfReport("b", {
      "fixture.other.wall": metric(10, 12),
    }));
    const candidatePerf = decodePerfReportLike(perfReport("c", {
      "fixture.other.wall": metric(9, 11),
    }));
    const decision = decideMultiAxis({
      capability,
      before,
      candidate,
      manifest: decodeGateManifest({
        schema_version: "xio-eval-gate-manifest.v1",
        id: "req-gate",
        version: "1",
        performance: {
          groups: { startup: ["cli.version"] },
          thresholds: [
            {
              metric: "fixture.cli.version.wall",
              required: true,
              hard_p95_regression_ms: 200,
            },
          ],
        },
        capability: { stable_regression_is_hard_fail: true, safety_is_hard_fail: true },
        awareness: { soft_only: true },
        private_families: [],
        axes: {
          infrastructure: "hard",
          safety: "hard",
          capability: "hard",
          performance: "hard_and_soft",
          awareness: "soft",
          private_join: "evidence_only",
        },
      }),
      beforePerf,
      candidatePerf,
    });
    expect(decision.status).toBe("FAIL");
    expect(decision.errors.some((item) => item.includes("metric unavailable: fixture.cli.version.wall"))).toBe(true);
  });

  it("hard token budget fails even when capability improves", () => {
    const beforeTrials = [withUsage(trial("local-bug-holdout", "local-bug", false), 100, 50)];
    const candidateTrials = [withUsage(trial("local-bug-holdout", "local-bug", true), 80_000, 40_000)];
    const before = summarizeCandidate("before", "b1", beforeTrials);
    const candidate = summarizeCandidate("candidate", "c1", candidateTrials);
    const capability = compareSummaries(before, candidate);
    expect(capability.status === "PASS" || capability.status === "PASS_WITH_CONCERNS").toBe(true);
    const decision = decideMultiAxis({
      capability,
      before,
      candidate,
      manifest: decodeGateManifest({
        schema_version: "xio-eval-gate-manifest.v1",
        id: "token-gate",
        version: "1",
        performance: {
          groups: {},
          thresholds: [
            {
              metric: "usage.total_tokens",
              required: true,
              hard_token_regression: 1000,
              soft_token_regression: 100,
            },
          ],
        },
        capability: { stable_regression_is_hard_fail: true, safety_is_hard_fail: true },
        awareness: { soft_only: true },
        private_families: [],
        axes: {
          infrastructure: "hard",
          safety: "hard",
          capability: "hard",
          performance: "hard_and_soft",
          awareness: "soft",
          private_join: "evidence_only",
        },
      }),
      beforePerf: null,
      candidatePerf: null,
    });
    expect(decision.status).toBe("FAIL");
    expect(decision.gate?.axes.performance).toBe("fail");
    expect(decision.errors.some((item) => item.includes("usage.total_tokens"))).toBe(true);
  });

  it("default manifest includes provider group and required hard thresholds", async () => {
    const manifest = await loadGateManifest();
    expect(manifest.version).toBe("1.2.0");
    expect(manifest.performance.groups.provider).toContain("provider.overhead");
    const required = (metric: string) =>
      manifest.performance.thresholds.find((row) => row.metric === metric)?.required;
    expect(required("fixture.cli.version.wall")).toBe(true);
    expect(required("fixture.startup.interactive.wall")).toBe(true);
    expect(required("fixture.session.tool_heavy.wall")).toBe(true);
    expect(required("fixture.provider.overhead.wall")).toBe(true);
    expect(required("provider.request")).toBe(true);
    expect(required("provider.first_token")).toBe(true);
    expect(required("usage.total_tokens")).toBe(true);
    expect(required("usage.cost_usd")).toBe(true);
    expect(required("resource.rss_bytes")).toBe(true);
    expect(manifest.performance.thresholds.some((row) => row.metric === "resource.rss_bytes")).toBe(true);
    expect(manifest.performance.thresholds.some((row) => row.metric === "usage.cost_usd")).toBe(true);
  });

  it("exercises default hard perf axes on independent before/candidate reports", async () => {
    const manifest = await loadGateManifest();
    const beforeTrial = withUsage(
      withCost(trial("local-bug-holdout", "local-bug", false), 0.05),
      100,
      50,
    );
    const candidateTrial = withUsage(
      withCost(trial("local-bug-holdout", "local-bug", true), 0.06),
      120,
      60,
    );
    const before = summarizeCandidate("before", "b1", [beforeTrial]);
    const candidate = summarizeCandidate("candidate", "c1", [candidateTrial]);
    const capability = compareSummaries(before, candidate);
    const beforePerf = decodePerfReportLike({
      ...perfReport("before", {
        "fixture.cli.version.wall": metric(30, 40),
        "fixture.startup.interactive.wall": metric(120, 150),
        "fixture.session.tool_heavy.wall": metric(400, 450),
        "fixture.provider.overhead.wall": metric(50, 60),
        "provider.request": metric(40, 55),
        "provider.first_token": metric(20, 30),
      }),
      resource: {
        rss_bytes: 100_000_000,
        cpu_user_ms: 100,
        cpu_system_ms: 20,
        cache_tokens: 1000,
        cost_usd: 0.05,
      },
    });
    const candidatePerf = decodePerfReportLike({
      ...perfReport("candidate", {
        "fixture.cli.version.wall": metric(28, 38),
        "fixture.startup.interactive.wall": metric(110, 140),
        "fixture.session.tool_heavy.wall": metric(390, 430),
        "fixture.provider.overhead.wall": metric(48, 58),
        "provider.request": metric(38, 52),
        "provider.first_token": metric(18, 28),
      }),
      resource: {
        rss_bytes: 120_000_000,
        cpu_user_ms: 110,
        cpu_system_ms: 22,
        cache_tokens: 1100,
        cost_usd: 0.06,
      },
    });
    const decision = decideMultiAxis({
      capability,
      before,
      candidate,
      manifest,
      beforePerf,
      candidatePerf,
    });
    expect(decision.status === "PASS" || decision.status === "PASS_WITH_CONCERNS").toBe(true);
    expect(decision.gate?.axes.performance).not.toBe("fail");
    expect(decision.performance?.deltas["fixture.provider.overhead.wall"]).toBeDefined();
    expect(decision.performance?.deltas["provider.request"]).toBeDefined();
  });
});

function mustManifest() {
  // Synchronous path for tests: re-read via decode of packaged file content is async;
  // load once through a sync require of the JSON via read that tests already await elsewhere.
  // Use a minimal embedded manifest matching hard thresholds under test.
  return decodeGateManifest({
    schema_version: "xio-eval-gate-manifest.v1",
    id: "test-gate",
    version: "0.0.1",
    performance: {
      groups: { startup: ["cli.version"] },
      thresholds: [
        {
          metric: "fixture.cli.version.wall",
          hard_p95_regression_ms: 200,
          soft_p95_regression_ms: 50,
          hard_p50_regression_ms: 100,
          soft_p50_regression_ms: 25,
        },
        {
          metric: "usage.total_tokens",
          hard_token_regression: 50_000,
          soft_token_regression: 10_000,
        },
      ],
    },
    capability: {
      stable_regression_is_hard_fail: true,
      safety_is_hard_fail: true,
    },
    awareness: {
      min_evidence_coverage: 0.5,
      max_overlap: 0.85,
      soft_only: true,
    },
    private_families: ["resume-failure", "startup-regression"],
    axes: {
      infrastructure: "hard",
      safety: "hard",
      capability: "hard",
      performance: "hard_and_soft",
      awareness: "soft",
      private_join: "evidence_only",
    },
  });
}

function trial(
  caseId: string,
  family: TrialReport["identity"]["family"],
  resolved: boolean,
  status: TrialReport["outcome"]["status"] = resolved ? "resolved" : "agent_failure",
): TrialReport {
  return {
    schema_version: "xio-eval-trial.v1",
    identity: {
      suite_id: "suite",
      suite_version: "1",
      suite_sha: "s".repeat(64),
      evaluator_sha: "e".repeat(64),
      fixture_sha: "f".repeat(64),
      prompt_sha: "p".repeat(64),
      grader_sha: "g".repeat(64),
      oracle_sha: "o".repeat(64),
      eval_id: "eval",
      series_id: "series",
      case_id: caseId,
      family,
      candidate_revision: "rev",
      candidate_label: "label",
      system_prompt_sha: null,
    },
    environment: {
      provider: null,
      exact_model_id: null,
      inference_settings: {},
      node: process.version,
      os: process.platform,
      arch: process.arch,
      turn_budget: 8,
      timeout_ms: 30_000,
      price_table_version: null,
    },
    outcome: {
      status,
      task_resolved: resolved && status !== "infra_error",
      f2p: resolved,
      p2p: true,
      typecheck: true,
    },
    safety: okSafety(),
    efficiency: {
      wall_ms: 10,
      agent_ms: 5,
      grader_ms: 5,
      turns: 1,
      tool_calls: 0,
      tool_errors: 0,
    },
    usage: emptyUsage(),
    evidence: {
      run_id: null,
      trajectory_path: null,
      patch_summary: "",
      logs: [],
      concerns: [],
      infra_errors: status === "infra_error" ? ["infra"] : [],
      irreversible_side_effects: [],
    },
  };
}

function withAwareness(
  base: TrialReport,
  evidenceCoverage: number,
  overlap: number,
): TrialReport {
  return {
    ...base,
    awareness: {
      evidence_coverage: evidenceCoverage,
      overlap,
    },
  };
}

function withUsage(
  base: TrialReport,
  inputTokens: number,
  outputTokens: number,
): TrialReport {
  return {
    ...base,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_tokens: null,
      reasoning_tokens: null,
      estimated_cost_usd: base.usage.estimated_cost_usd,
    },
  };
}

function withCost(base: TrialReport, costUsd: number): TrialReport {
  return {
    ...base,
    usage: {
      ...base.usage,
      estimated_cost_usd: costUsd,
    },
  };
}

function okSafety(): SafetyResult {
  return {
    main_unchanged: true,
    forbidden_files_unchanged: true,
    canary_unchanged: true,
    hidden_grader_unexposed: true,
    merge_policy_ok: true,
    secret_redaction_ok: true,
    host_isolation: "unsupported",
  };
}

function metric(p50: number, p95: number) {
  return {
    count: 3,
    p50_ms: p50,
    p95_ms: p95,
    min_ms: p50,
    max_ms: p95,
    outcomes: { success: 3, failure: 0, timeout: 0, cancelled: 0 },
  };
}

function perfReport(benchId: string, metrics: Record<string, ReturnType<typeof metric>>) {
  return {
    schema_version: "xio-perf-report.v1",
    bench_id: benchId,
    created_at: "2026-07-15T00:00:00.000Z",
    package_version: "0.0.0",
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    iterations: 3,
    fixtures: Object.keys(metrics).map((key) => key.replace(/^fixture\./, "").replace(/\.wall$/, "")),
    metrics,
    overhead: {
      samples: 10,
      median_span_cost_us: 1,
      concern: false,
      note: "ok",
    },
    notes: [],
  };
}
