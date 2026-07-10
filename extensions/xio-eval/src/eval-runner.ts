import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { compareSummaries, decideSmoke, summarizeCandidate } from "./comparator.ts";
import { candidateRevision } from "./evidence.ts";
import {
  comparisonCompatibilityErrors,
  finalSeriesId,
  resolveEvalRoot,
  runWithConcurrency,
  selectedHoldouts,
  withSeriesId,
  writeReport,
} from "./eval-support.ts";
import { runPreflight } from "./preflight.ts";
import { loadPriceTable } from "./price-table.ts";
import { hashValue, loadTrustedSuite } from "./suite-loader.ts";
import { runTrial } from "./trial-runner.ts";

import type { EvalContext } from "./eval-support.ts";
import type {
  CandidateMode,
  EvalReport,
  EvalRunOptions,
  LoadedFixture,
  TrialReport,
} from "./types.ts";

export class EvalRunner {
  readonly #options: EvalRunOptions;

  constructor(options: EvalRunOptions) {
    this.#options = options;
  }

  async preflight(): Promise<EvalReport> {
    const context = await this.#createContext("preflight");
    const result = await runPreflight(this.#options.trusted_root, context.suite);
    const report: EvalReport = {
      schema_version: "xio-eval-report.v1",
      eval_id: context.evalId,
      series_id: context.provisionalSeriesId,
      mode: "preflight",
      status: result.ok ? "PASS" : "FAIL",
      created_at: context.createdAt,
      suite: context.suite.identity,
      candidates: [],
      paired_deltas: {},
      concerns: [],
      errors: result.errors,
    };
    await writeReport(context.reportRoot, report);
    return report;
  }

  async smoke(): Promise<EvalReport> {
    const context = await this.#createContext("smoke");
    const preflight = await runPreflight(this.#options.trusted_root, context.suite);
    if (!preflight.ok) {
      return this.#invalidSuiteReport(context, "smoke", preflight.errors);
    }
    const candidateRoot = this.#options.candidate_root ?? this.#options.trusted_root;
    const fixtures = selectedHoldouts(context.suite, this.#options.case_ids);
    const revision = await candidateRevision(candidateRoot);
    const trials = await runWithConcurrency(fixtures, 2, (fixture) =>
      this.#runTrial(context, fixture, candidateRoot, "candidate", revision));
    const seriesId = finalSeriesId(context, trials);
    const finalized = withSeriesId(trials, seriesId);
    const summary = summarizeCandidate("candidate", revision, finalized);
    const decision = decideSmoke(summary, this.#mode());
    return this.#saveDecision(context, "smoke", seriesId, [summary], decision);
  }

  async compare(): Promise<EvalReport> {
    const context = await this.#createContext("compare");
    const preflight = await runPreflight(this.#options.trusted_root, context.suite);
    if (!preflight.ok) {
      return this.#invalidSuiteReport(context, "compare", preflight.errors);
    }
    const beforeRoot = this.#options.before_root;
    const candidateRoot = this.#options.candidate_root;
    if (!beforeRoot || !candidateRoot) {
      return this.#invalidSuiteReport(context, "compare", ["compare requires before_root and candidate_root"]);
    }
    const fixtures = selectedHoldouts(context.suite, this.#options.case_ids);
    const [beforeRevision, candidateRevisionValue] = await Promise.all([
      candidateRevision(beforeRoot),
      candidateRevision(candidateRoot),
    ]);
    const pair = await this.#runComparisonTrials(context, fixtures, {
      before: { root: beforeRoot, revision: beforeRevision },
      candidate: { root: candidateRoot, revision: candidateRevisionValue },
    });
    const seriesId = finalSeriesId(context, [...pair.before, ...pair.candidate]);
    const before = summarizeCandidate("before", beforeRevision, withSeriesId(pair.before, seriesId));
    const candidate = summarizeCandidate("candidate", candidateRevisionValue, withSeriesId(pair.candidate, seriesId));
    const decision = compareSummaries(before, candidate);
    const compatibilityErrors = comparisonCompatibilityErrors(before.trials, candidate.trials);
    if (compatibilityErrors.length > 0) {
      return this.#saveDecision(context, "compare", seriesId, [before, candidate], {
        status: "INFRA_ERROR",
        pairedDeltas: decision.pairedDeltas,
        concerns: decision.concerns,
        errors: [...decision.errors, ...compatibilityErrors],
      });
    }
    return this.#saveDecision(context, "compare", seriesId, [before, candidate], decision);
  }

  async #runComparisonTrials(
    context: EvalContext,
    fixtures: readonly LoadedFixture[],
    candidates: Readonly<Record<"before" | "candidate", { root: string; revision: string }>>,
  ): Promise<Readonly<Record<"before" | "candidate", TrialReport[]>>> {
    const result = { before: [] as TrialReport[], candidate: [] as TrialReport[] };
    for (let index = 0; index < fixtures.length; index += 1) {
      const fixture = fixtures[index]!;
      const order = index % 2 === 0 ? ["before", "candidate"] as const : ["candidate", "before"] as const;
      for (const label of order) {
        result[label].push(await this.#runTrial(context, fixture, candidates[label].root, label, candidates[label].revision));
      }
      const before = result.before.at(-1)!;
      const candidate = result.candidate.at(-1)!;
      if (before.outcome.task_resolved !== candidate.outcome.task_resolved || before.outcome.status === "infra_error"
        || candidate.outcome.status === "infra_error") {
        for (let repeat = 0; repeat < 2; repeat += 1) {
          for (const label of [...order].reverse()) {
            result[label].push(await this.#runTrial(context, fixture, candidates[label].root, label, candidates[label].revision));
          }
        }
      }
    }
    return result;
  }

  async #runTrial(
    context: EvalContext,
    fixture: LoadedFixture,
    candidateRoot: string,
    label: string,
    revision: string,
  ): Promise<TrialReport> {
    return runTrial({
      context,
      trustedRoot: this.#options.trusted_root,
      candidateRoot,
      candidateLabel: label,
      candidateRevision: revision,
      candidateMode: this.#mode(),
      fixture,
      env: this.#options.env,
    });
  }

  async #createContext(mode: EvalReport["mode"]): Promise<EvalContext> {
    const [suite, priceTable] = await Promise.all([
      loadTrustedSuite(this.#options.trusted_root),
      loadPriceTable(this.#options.price_table_path),
    ]);
    const createdAt = (this.#options.now ?? (() => new Date()))().toISOString();
    const evalId = `eval-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const reportRoot = path.join(resolveEvalRoot(this.#options.eval_root), evalId);
    await mkdir(reportRoot, { recursive: true });
    return {
      suite,
      createdAt,
      evalId,
      reportRoot,
      priceTable,
      provisionalSeriesId: hashValue({
        suite: suite.identity,
        mode,
        candidateMode: this.#mode(),
        priceTableVersion: priceTable?.version ?? null,
      }),
    };
  }

  #mode(): CandidateMode {
    return this.#options.candidate_mode ?? "real";
  }

  async #invalidSuiteReport(context: EvalContext, mode: EvalReport["mode"], errors: readonly string[]): Promise<EvalReport> {
    const report: EvalReport = {
      schema_version: "xio-eval-report.v1",
      eval_id: context.evalId,
      series_id: context.provisionalSeriesId,
      mode,
      status: "FAIL",
      created_at: context.createdAt,
      suite: context.suite.identity,
      candidates: [],
      paired_deltas: {},
      concerns: [],
      errors,
    };
    await writeReport(context.reportRoot, report);
    return report;
  }

  async #saveDecision(
    context: EvalContext,
    mode: EvalReport["mode"],
    seriesId: string,
    candidates: EvalReport["candidates"],
    decision: { status: EvalReport["status"]; pairedDeltas: Readonly<Record<string, number>>; concerns: readonly string[]; errors: readonly string[] },
  ): Promise<EvalReport> {
    const report: EvalReport = {
      schema_version: "xio-eval-report.v1",
      eval_id: context.evalId,
      series_id: seriesId,
      mode,
      status: decision.status,
      created_at: context.createdAt,
      suite: context.suite.identity,
      candidates,
      paired_deltas: decision.pairedDeltas,
      concerns: decision.concerns,
      errors: decision.errors,
    };
    await writeReport(context.reportRoot, report);
    return report;
  }
}
