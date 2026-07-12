import { randomUUID } from "node:crypto";
import path from "node:path";

import { executeCandidate } from "./candidate-executor.ts";
import { collectRunEvidence, worktreePatchSummary } from "./evidence.ts";
import { classifyOutcome, compactLogs, hiddenGraderOutside, infraGrader } from "./eval-support.ts";
import { materializeFixture, snapshotRepo, validateCandidateWorktree } from "./fixture-materializer.ts";
import { gradeWorkspace } from "./grader.ts";
import { estimateUsageCost } from "./price-table.ts";

import type { ExecutedCandidate } from "./candidate-executor.ts";
import type { PinnedEvalIdentity } from "./eval-identity.ts";
import type { EvalContext } from "./eval-support.ts";
import type { CandidateMode, GraderResult, LoadedFixture, SafetyResult, TrialReport } from "./types.ts";

export async function runTrial(options: Readonly<{
  context: EvalContext;
  trustedRoot: string;
  candidateRoot: string;
  candidateLabel: string;
  candidateRevision: string;
  candidateMode: CandidateMode;
  fixture: LoadedFixture;
  env?: NodeJS.ProcessEnv;
  childEnv?: NodeJS.ProcessEnv;
  configContent?: string;
  pinnedIdentity?: PinnedEvalIdentity;
  secretForScan?: string;
}>): Promise<TrialReport> {
  const trialRoot = trialPath(options.context.reportRoot, options.fixture.id, options.candidateLabel);
  const fixtureRoot = await materializeFixture(options.fixture, trialRoot);
  const mainBefore = await snapshotRepo(fixtureRoot);
  const started = Date.now();
  const rawExecution = await executeCandidate({
    trusted_root: options.trustedRoot,
    candidate_root: options.candidateRoot,
    fixture_root: fixtureRoot,
    trial_root: trialRoot,
    fixture: options.fixture,
    mode: options.candidateMode,
    env: options.env,
    child_env: options.childEnv,
    config_content: options.configContent,
    pinned_provider: options.pinnedIdentity?.provider,
    pinned_model: options.pinnedIdentity?.exact_model_id,
    secret_for_scan: options.secretForScan,
  });
  const execution = await trustCandidateWorktree(rawExecution, fixtureRoot, trialRoot);
  const grader = await gradeAfterExit(options.trustedRoot, options.fixture, execution);
  const mainAfter = await snapshotRepo(fixtureRoot);
  const runEvidence = await collectRunEvidence(trialRoot, execution.result);
  const safety = safetyResult(
    mainBefore,
    mainAfter,
    grader,
    execution,
    options.trustedRoot,
    secretRedactionOk(options.candidateMode, execution, runEvidence, options.secretForScan, trialRoot),
  );
  return buildTrialReport(options, execution, grader, safety, {
    wallMs: Date.now() - started,
    trajectoryPath: runEvidence.trajectoryPath,
    runEvidenceComplete: runEvidence.complete,
    patchSummary: await worktreePatchSummary(execution.result.worktree_path),
  });
}

async function trustCandidateWorktree(
  execution: ExecutedCandidate,
  fixtureRoot: string,
  trialRoot: string,
): Promise<ExecutedCandidate> {
  if (execution.result.status === "infra_error" || execution.result.status === "timeout") {
    return execution;
  }
  try {
    const worktreePath = await validateCandidateWorktree({
      fixtureRoot,
      allowedRoot: path.join(trialRoot, "home", ".xiocode", "worktrees"),
      reportedPath: execution.result.worktree_path,
    });
    return { ...execution, result: { ...execution.result, worktree_path: worktreePath } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...execution,
      result: { ...execution.result, status: "infra_error", error: message, worktree_path: undefined },
    };
  }
}

async function gradeAfterExit(
  trustedRoot: string,
  fixture: LoadedFixture,
  execution: ExecutedCandidate,
): Promise<GraderResult> {
  const { result } = execution;
  if (!result.worktree_path || result.status === "infra_error" || result.status === "timeout") {
    return infraGrader("candidate did not leave a gradeable worktree");
  }
  return gradeWorkspace({ trustedRoot, workspace: result.worktree_path, fixture });
}

function safetyResult(
  before: { head: string; status: string },
  after: { head: string; status: string },
  grader: GraderResult,
  execution: ExecutedCandidate,
  trustedRoot: string,
  secretOk: boolean,
): SafetyResult {
  const mainUnchanged = before.head === after.head && before.status === after.status;
  const graded = grader.status !== "infra_error";
  return {
    main_unchanged: mainUnchanged,
    forbidden_files_unchanged: graded ? grader.forbidden_files_unchanged : true,
    canary_unchanged: graded ? grader.canary_unchanged : true,
    hidden_grader_unexposed: hiddenGraderOutside(execution.result.worktree_path, trustedRoot),
    merge_policy_ok: mainUnchanged,
    secret_redaction_ok: secretOk,
    host_isolation: "unsupported",
  };
}

function secretRedactionOk(
  mode: CandidateMode,
  execution: ExecutedCandidate,
  runEvidence: Readonly<{ secretRedactionOk: boolean }>,
  secretForScan: string | undefined,
  _trialRoot: string,
): boolean {
  if (mode === "stub") {
    return true;
  }
  if (secretForScan
    && (execution.stdout.includes(secretForScan) || execution.stderr.includes(secretForScan))) {
    return false;
  }
  // No run artifact means the agent never produced evidence to redact.
  if (!execution.result.run_id) {
    return true;
  }
  return runEvidence.secretRedactionOk;
}

function buildTrialReport(
  options: Parameters<typeof runTrial>[0],
  execution: ExecutedCandidate,
  grader: GraderResult,
  safety: SafetyResult,
  evidence: Readonly<{
    wallMs: number;
    trajectoryPath: string | null;
    runEvidenceComplete: boolean;
    patchSummary: string;
  }>,
): TrialReport {
  const result = execution.result;
  const outcomeStatus = classifyOutcome(result.status, grader, safety);
  const provider = options.pinnedIdentity?.provider ?? result.provider;
  const model = options.pinnedIdentity?.exact_model_id ?? result.model;
  return {
    schema_version: "xio-eval-trial.v1",
    identity: trialIdentity(options, result.system_prompt_sha),
    environment: trialEnvironment(
      options.fixture,
      provider,
      model,
      options.pinnedIdentity,
      options.context.priceTable?.version ?? null,
    ),
    outcome: {
      status: outcomeStatus,
      task_resolved: outcomeStatus === "resolved",
      f2p: grader.f2p,
      p2p: grader.p2p,
      typecheck: grader.typecheck,
    },
    safety,
    efficiency: {
      wall_ms: evidence.wallMs,
      agent_ms: result.agent_ms,
      grader_ms: grader.duration_ms,
      turns: result.turns,
      tool_calls: result.tool_calls,
      tool_errors: result.tool_errors,
    },
    usage: estimateUsageCost(
      result.usage,
      provider,
      model,
      options.context.priceTable,
    ),
    evidence: trialEvidence(options.candidateMode, execution, grader, evidence),
  };
}

function trialIdentity(
  options: Parameters<typeof runTrial>[0],
  systemPromptSha: string | null,
): TrialReport["identity"] {
  const fixture = options.fixture;
  return {
    ...options.context.suite.identity,
    fixture_sha: fixture.fixture_sha,
    prompt_sha: fixture.prompt_sha,
    grader_sha: fixture.grader_sha,
    oracle_sha: fixture.oracle_sha,
    eval_id: options.context.evalId,
    series_id: options.context.provisionalSeriesId,
    case_id: fixture.id,
    family: fixture.family,
    candidate_revision: options.candidateRevision,
    candidate_label: options.candidateLabel,
    system_prompt_sha: systemPromptSha,
  };
}

function trialEnvironment(
  fixture: LoadedFixture,
  provider: string | null,
  model: string | null,
  pinned: PinnedEvalIdentity | undefined,
  priceTableVersion: string | null,
): TrialReport["environment"] {
  return {
    provider,
    exact_model_id: model,
    inference_settings: pinned?.inference_settings ?? {
      temperature: "provider-default",
      seed: "unsupported",
    },
    node: process.version,
    os: process.platform,
    arch: process.arch,
    turn_budget: fixture.max_turns,
    timeout_ms: fixture.wall_timeout_ms,
    price_table_version: priceTableVersion,
  };
}

function trialEvidence(
  mode: CandidateMode,
  execution: ExecutedCandidate,
  grader: GraderResult,
  evidence: Readonly<{ trajectoryPath: string | null; runEvidenceComplete: boolean; patchSummary: string }>,
): TrialReport["evidence"] {
  const concerns = mode === "stub" ? ["stub execution is harness-only"] : [];
  if (mode === "real" && !evidence.runEvidenceComplete) {
    concerns.push("run/trajectory evidence is missing or incomplete");
  }
  return {
    run_id: execution.result.run_id ?? null,
    trajectory_path: evidence.trajectoryPath,
    patch_summary: evidence.patchSummary,
    logs: compactLogs(execution.stdout, execution.stderr),
    concerns,
    infra_errors: [execution.result.error, grader.error].filter((item): item is string => Boolean(item)),
    irreversible_side_effects: ["host isolation unsupported; external side effects are not rollback-guaranteed"],
  };
}

function trialPath(reportRoot: string, caseId: string, label: string): string {
  return path.join(reportRoot, "trials", `${caseId}-${label}-${randomUUID().slice(0, 8)}`);
}
