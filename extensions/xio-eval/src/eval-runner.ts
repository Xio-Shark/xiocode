import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { compareSummaries, decideSmoke, summarizeCandidate } from "./comparator.ts";
import { prepareCredentialedEvalSetup } from "./credentialed-env.ts";
import { writeCredentialedSeries } from "./credentialed-series.ts";
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

import type { CredentialedEvalSetup } from "./credentialed-env.ts";
import type { PinnedEvalIdentity } from "./eval-identity.ts";
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
    const credentialed = await this.#prepareRealSetup(context);
    if (credentialed && "error" in credentialed) {
      return this.#infraSetupReport(context, "smoke", credentialed.error);
    }
    const setup = credentialed && "setup" in credentialed ? credentialed.setup : undefined;
    const candidateRoot = this.#options.candidate_root ?? this.#options.trusted_root;
    const fixtures = expandRepeats(selectedHoldouts(context.suite, this.#options.case_ids), this.#repeat());
    const revision = await candidateRevision(candidateRoot);
    const trials = await runWithConcurrency(fixtures, 2, (fixture) =>
      this.#runTrial(context, fixture, candidateRoot, "candidate", revision, setup));
    const seriesId = finalSeriesId(context, trials, setup?.identity, this.#repeat());
    const finalized = withSeriesId(trials, seriesId);
    const summary = summarizeCandidate("candidate", revision, finalized);
    const decision = decideSmoke(summary, this.#mode());
    return this.#saveDecision(context, "smoke", seriesId, [summary], decision, setup?.identity);
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
    const credentialed = await this.#prepareRealSetup(context);
    if (credentialed && "error" in credentialed) {
      return this.#infraSetupReport(context, "compare", credentialed.error);
    }
    const setup = credentialed && "setup" in credentialed ? credentialed.setup : undefined;
    const fixtures = expandRepeats(selectedHoldouts(context.suite, this.#options.case_ids), this.#repeat());
    const [beforeRevision, candidateRevisionValue] = await Promise.all([
      candidateRevision(beforeRoot),
      candidateRevision(candidateRoot),
    ]);
    const pair = await this.#runComparisonTrials(context, fixtures, {
      before: { root: beforeRoot, revision: beforeRevision },
      candidate: { root: candidateRoot, revision: candidateRevisionValue },
    }, setup);
    const seriesId = finalSeriesId(context, [...pair.before, ...pair.candidate], setup?.identity, this.#repeat());
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
      }, setup?.identity);
    }
    return this.#saveDecision(context, "compare", seriesId, [before, candidate], decision, setup?.identity);
  }

  async #runComparisonTrials(
    context: EvalContext,
    fixtures: readonly LoadedFixture[],
    candidates: Readonly<Record<"before" | "candidate", { root: string; revision: string }>>,
    setup: CredentialedEvalSetup | undefined,
  ): Promise<Readonly<Record<"before" | "candidate", TrialReport[]>>> {
    const result = { before: [] as TrialReport[], candidate: [] as TrialReport[] };
    for (let index = 0; index < fixtures.length; index += 1) {
      const fixture = fixtures[index]!;
      const order = index % 2 === 0 ? ["before", "candidate"] as const : ["candidate", "before"] as const;
      for (const label of order) {
        result[label].push(await this.#runTrial(
          context,
          fixture,
          candidates[label].root,
          label,
          candidates[label].revision,
          setup,
        ));
      }
      const before = result.before.at(-1)!;
      const candidate = result.candidate.at(-1)!;
      if (before.outcome.task_resolved !== candidate.outcome.task_resolved || before.outcome.status === "infra_error"
        || candidate.outcome.status === "infra_error") {
        for (let repeat = 0; repeat < 2; repeat += 1) {
          for (const label of [...order].reverse()) {
            result[label].push(await this.#runTrial(
              context,
              fixture,
              candidates[label].root,
              label,
              candidates[label].revision,
              setup,
            ));
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
    setup: CredentialedEvalSetup | undefined,
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
      childEnv: setup?.childEnv,
      configContent: setup?.configContent,
      pinnedIdentity: setup?.identity,
      secretForScan: setup?.secretForScan,
    });
  }

  async #prepareRealSetup(
    context: EvalContext,
  ): Promise<{ setup: CredentialedEvalSetup } | { error: string } | undefined> {
    if (this.#mode() !== "real") {
      return undefined;
    }
    try {
      const setup = await prepareCredentialedEvalSetup({
        env: this.#options.env ?? process.env,
        modelRef: this.#options.model,
      });
      context.pinnedIdentity = setup.identity;
      return { setup };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async #createContext(mode: EvalReport["mode"]): Promise<EvalContext> {
    const [suite, priceTable] = await Promise.all([
      loadTrustedSuite(this.#options.trusted_root),
      loadPriceTable(this.#options.price_table_path),
    ]);
    const createdAt = (this.#options.now ?? (() => new Date()))().toISOString();
    const evalId = `eval-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const evalRoot = resolveEvalRoot(this.#options.eval_root);
    const reportRoot = path.join(evalRoot, evalId);
    await mkdir(reportRoot, { recursive: true });
    return {
      suite,
      createdAt,
      evalId,
      evalRoot,
      reportRoot,
      priceTable,
      provisionalSeriesId: hashValue({
        suite: suite.identity,
        mode,
        candidateMode: this.#mode(),
        model: this.#options.model ?? null,
        repeat: this.#repeat(),
        priceTableVersion: priceTable?.version ?? null,
      }),
      repeat: this.#repeat(),
    };
  }

  #mode(): CandidateMode {
    return this.#options.candidate_mode ?? "real";
  }

  #repeat(): number {
    return this.#options.repeat ?? 1;
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

  async #infraSetupReport(context: EvalContext, mode: EvalReport["mode"], error: string): Promise<EvalReport> {
    const report: EvalReport = {
      schema_version: "xio-eval-report.v1",
      eval_id: context.evalId,
      series_id: context.provisionalSeriesId,
      mode,
      status: "INFRA_ERROR",
      created_at: context.createdAt,
      suite: context.suite.identity,
      candidates: [],
      paired_deltas: {},
      concerns: [],
      errors: [error],
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
    identity?: PinnedEvalIdentity,
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
    if (this.#mode() === "real" && identity) {
      const reportJson = `${JSON.stringify(report, null, 2)}\n`;
      await writeCredentialedSeries(context.evalRoot, report, {
        identity,
        repeat: this.#repeat(),
        reportJson,
      });
    }
    return report;
  }
}

function expandRepeats(fixtures: readonly LoadedFixture[], repeat: number): LoadedFixture[] {
  if (repeat <= 1) return [...fixtures];
  const expanded: LoadedFixture[] = [];
  for (const fixture of fixtures) {
    for (let index = 0; index < repeat; index += 1) {
      expanded.push(fixture);
    }
  }
  return expanded;
}
