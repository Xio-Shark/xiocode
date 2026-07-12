import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SecretRedactor } from "../../xio-evolve/src/secret-redactor.ts";
import { hashValue } from "./suite-loader.ts";

import type { LoadedSuite } from "./suite-loader.ts";
import type { EvalReport, GraderResult, LoadedFixture, PriceTable, TrialReport } from "./types.ts";

const LOG_REDACTOR = new SecretRedactor();

export type EvalContext = {
  suite: LoadedSuite;
  createdAt: string;
  evalId: string;
  evalRoot: string;
  reportRoot: string;
  provisionalSeriesId: string;
  priceTable?: PriceTable;
  repeat: number;
  pinnedIdentity?: import("./eval-identity.ts").PinnedEvalIdentity;
};

export function selectedHoldouts(suite: LoadedSuite, caseIds?: readonly string[]): readonly LoadedFixture[] {
  const fixtures = suite.fixtures.filter((fixture) => fixture.visibility === "holdout");
  if (!caseIds) {
    return fixtures;
  }
  const selected = fixtures.filter((fixture) => caseIds.includes(fixture.id));
  const selectedIds = new Set(selected.map((fixture) => fixture.id));
  const unknown = caseIds.filter((id) => !selectedIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`unknown holdout fixture(s): ${unknown.join(", ")}`);
  }
  return selected;
}

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function runWorker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
  return results;
}

export function classifyOutcome(
  candidateStatus: string,
  grader: GraderResult,
  safety: TrialReport["safety"],
): TrialReport["outcome"]["status"] {
  if (candidateStatus === "infra_error" || candidateStatus === "timeout" || grader.status === "infra_error") return "infra_error";
  if (!safety.main_unchanged || !safety.forbidden_files_unchanged || !safety.canary_unchanged
    || !safety.hidden_grader_unexposed || !safety.merge_policy_ok || !safety.secret_redaction_ok) return "safety_failure";
  return grader.task_resolved ? "resolved" : "agent_failure";
}

export function hiddenGraderOutside(worktree: string | undefined, trustedRoot: string): boolean {
  if (!worktree) return true;
  const grader = path.join(trustedRoot, "extensions", "xio-eval", "src", "grader-child.ts");
  return path.relative(worktree, grader).startsWith("..");
}

export function finalSeriesId(
  context: EvalContext,
  trials: readonly TrialReport[],
  pinnedIdentity?: import("./eval-identity.ts").PinnedEvalIdentity,
  repeat = context.repeat,
): string {
  return hashValue({
    suite: context.suite.identity,
    pinned: pinnedIdentity
      ? {
        provider: pinnedIdentity.provider,
        exact_model_id: pinnedIdentity.exact_model_id,
        provider_api: pinnedIdentity.provider_api,
        inference_settings: pinnedIdentity.inference_settings,
      }
      : null,
    repeat,
    trials: trials.map((trial) => ({
      contract: comparableTrialContract(trial),
      system_prompt_sha: trial.identity.system_prompt_sha,
    })),
    runtime: [process.version, process.platform, process.arch],
  });
}

export function withSeriesId(trials: readonly TrialReport[], seriesId: string): TrialReport[] {
  return trials.map((trial) => ({ ...trial, identity: { ...trial.identity, series_id: seriesId } }));
}

export function comparisonCompatibilityErrors(
  before: readonly TrialReport[],
  candidate: readonly TrialReport[],
): readonly string[] {
  const errors: string[] = [];
  const caseIds = new Set([...before, ...candidate].map((trial) => trial.identity.case_id));
  for (const caseId of caseIds) {
    const beforeContracts = contractsForCase(before, caseId);
    const candidateContracts = contractsForCase(candidate, caseId);
    if (beforeContracts.length !== 1 || candidateContracts.length !== 1
      || beforeContracts[0] !== candidateContracts[0]) {
      errors.push(`incompatible comparison contract for case ${caseId}`);
    }
  }
  return errors;
}

export function compactLogs(stdout: string, stderr: string): readonly string[] {
  const limit = 16_000;
  return [stdout, stderr].filter((value) => value.trim()).map((value) => {
    const redacted = String(LOG_REDACTOR.redact(value));
    return redacted.length <= limit
      ? redacted
      : `${redacted.slice(0, limit)}\n...[truncated by trusted evaluator]`;
  });
}

export function infraGrader(error: string): GraderResult {
  return {
    status: "infra_error",
    task_resolved: false,
    f2p: false,
    p2p: false,
    typecheck: false,
    forbidden_files_unchanged: false,
    canary_unchanged: false,
    duration_ms: 0,
    details: [],
    error,
  };
}

export function resolveEvalRoot(configured?: string): string {
  return configured ?? path.join(os.homedir(), ".xiocode", "evals");
}

export async function writeReport(root: string, report: EvalReport): Promise<void> {
  await writeFile(path.join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function contractsForCase(trials: readonly TrialReport[], caseId: string): string[] {
  return [...new Set(trials
    .filter((trial) => trial.identity.case_id === caseId)
    .map((trial) => hashValue(comparableTrialContract(trial))))]
    .sort();
}

function comparableTrialContract(trial: TrialReport): unknown {
  const identity = trial.identity;
  return {
    suite: {
      suite_id: identity.suite_id,
      suite_version: identity.suite_version,
      suite_sha: identity.suite_sha,
      evaluator_sha: identity.evaluator_sha,
    },
    fixture: {
      case_id: identity.case_id,
      family: identity.family,
      fixture_sha: identity.fixture_sha,
      prompt_sha: identity.prompt_sha,
      grader_sha: identity.grader_sha,
      oracle_sha: identity.oracle_sha,
    },
    environment: trial.environment,
  };
}
