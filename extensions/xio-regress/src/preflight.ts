import { RegressionCaseStore } from "./case-store.ts";
import { evidenceHashesMatch } from "./run-evidence-reader.ts";
import {
  assertBaseCommit,
  cleanupWorktree,
  createPinnedBaseWorktree,
  errorMessage,
  runVerifier,
  sourceSnapshot,
  sourceUnchanged,
  statusHash,
  verifierInfraErrors,
} from "./verifier-exec.ts";

import type { PrivateRegressionCase, PrivateRegressionPreflight, PreflightStatus } from "./types.ts";
import type { SpawnResult } from "../../xio-eval/src/process.ts";
import type { SourceSnapshot } from "./verifier-exec.ts";
import type { WorktreeSession } from "../../xio-sandbox/src/worktree-sandbox.ts";

type ExecuteOptions = Readonly<{
  regression: PrivateRegressionCase;
  before: SourceSnapshot;
  concerns: readonly string[];
  started: number;
}>;
type FinishOptions = ExecuteOptions & Readonly<{
  session: WorktreeSession;
  outcome: SpawnResult;
}>;

export class RegressionPreflight {
  private readonly store: RegressionCaseStore;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: Readonly<{ store?: RegressionCaseStore; env?: NodeJS.ProcessEnv }> = {}) {
    this.store = options.store ?? new RegressionCaseStore();
    this.env = options.env ?? process.env;
  }

  async run(caseId: string): Promise<PrivateRegressionPreflight> {
    const started = Date.now();
    const regression = await this.store.readCase(caseId);
    const hashesMatch = await evidenceHashesMatch(regression);
    if (!hashesMatch) {
      return this.persist(infraResult({
        regression, started, hashesMatch: false, errors: ["run artifact hash mismatch"],
      }));
    }
    let before: SourceSnapshot;
    try {
      before = await sourceSnapshot(regression.source.repo_root);
    } catch (error) {
      return this.persist(infraResult({
        regression, started, hashesMatch: true, unchanged: false, errors: [errorMessage(error)],
      }));
    }
    try {
      await assertBaseCommit(regression);
    } catch (error) {
      const unchanged = await sourceUnchanged(regression.source.repo_root, before);
      return this.persist(infraResult({
        regression, started, hashesMatch: true, unchanged, errors: [errorMessage(error)],
      }));
    }
    const concerns = preflightConcerns(regression, before);
    if (concerns.includes("source_dirty_state_changed_since_run")) {
      return this.persist(infraResult({
        regression,
        started,
        hashesMatch: true,
        unchanged: true,
        concerns,
        errors: ["source dirty state does not match recorded provenance"],
      }));
    }
    return this.execute({ regression, before, concerns, started });
  }

  private async execute(options: ExecuteOptions): Promise<PrivateRegressionPreflight> {
    const { regression, before, concerns, started } = options;
    let session: WorktreeSession | undefined;
    try {
      session = await createPinnedBaseWorktree(regression, this.store.root);
      const outcome = await runVerifier(regression, session.worktreePath, this.env);
      return await this.finish({ regression, session, before, concerns, outcome, started });
    } catch (error) {
      const cleanup = session
        ? await cleanupWorktree(session)
        : { temporaryWorktree: null, errors: [] };
      const unchanged = await sourceUnchanged(regression.source.repo_root, before);
      const errors = [errorMessage(error), ...cleanup.errors];
      if (!unchanged) errors.push("source main changed during preflight");
      return this.persist(infraResult({
        regression,
        started,
        hashesMatch: true,
        unchanged,
        concerns,
        errors,
        temporaryWorktree: cleanup.temporaryWorktree ?? undefined,
      }));
    }
  }

  private async finish(options: FinishOptions): Promise<PrivateRegressionPreflight> {
    const { regression, session, before, concerns, outcome, started } = options;
    const errors: string[] = verifierInfraErrors(outcome);
    const cleanup = await cleanupWorktree(session);
    errors.push(...cleanup.errors);
    const unchanged = await sourceUnchanged(regression.source.repo_root, before);
    if (!unchanged) errors.push("source main changed during preflight");
    const status = classifyStatus(regression, outcome, errors);
    return this.persist(buildResult({
      regression,
      status,
      outcome,
      started,
      unchanged,
      concerns,
      errors,
      temporaryWorktree: cleanup.temporaryWorktree,
    }));
  }

  private async persist(value: PrivateRegressionPreflight): Promise<PrivateRegressionPreflight> {
    await this.store.writePreflight(value);
    return value;
  }
}

function preflightConcerns(regression: PrivateRegressionCase, snapshot: SourceSnapshot): readonly string[] {
  const concerns = new Set(regression.concerns);
  concerns.add("host_isolation_unsupported");
  if (regression.source.dirty_summary_sha
    && regression.source.dirty_summary_sha !== statusHash(snapshot.status)) {
    concerns.add("source_dirty_state_changed_since_run");
  }
  return [...concerns].sort();
}

function classifyStatus(
  regression: PrivateRegressionCase,
  outcome: SpawnResult,
  errors: readonly string[],
): PreflightStatus {
  if (errors.length > 0) return "INFRA_ERROR";
  return outcome.code === regression.verifier.expected_exit ? "INVALID_CASE" : "BASE_RED";
}

function buildResult(options: Readonly<{
  regression: PrivateRegressionCase;
  status: PreflightStatus;
  outcome: SpawnResult;
  started: number;
  unchanged: boolean;
  concerns: readonly string[];
  errors: readonly string[];
  temporaryWorktree: string | null;
}>): PrivateRegressionPreflight {
  const { regression, status, outcome, started, unchanged, concerns, errors, temporaryWorktree } = options;
  return {
    schema_version: "private-regression-preflight.v1",
    case_id: regression.case_id,
    status,
    actual_exit: outcome.code,
    duration_ms: Date.now() - started,
    source_main_unchanged: unchanged,
    artifact_hashes_match: true,
    temporary_worktree: temporaryWorktree,
    host_isolation: "unsupported",
    concerns,
    errors,
  };
}

function infraResult(options: Readonly<{
  regression: PrivateRegressionCase;
  started: number;
  hashesMatch: boolean;
  unchanged?: boolean;
  concerns?: readonly string[];
  errors: readonly string[];
  temporaryWorktree?: string;
}>): PrivateRegressionPreflight {
  const { regression, started, hashesMatch, errors } = options;
  return {
    schema_version: "private-regression-preflight.v1",
    case_id: regression.case_id,
    status: "INFRA_ERROR",
    actual_exit: null,
    duration_ms: Date.now() - started,
    source_main_unchanged: options.unchanged ?? true,
    artifact_hashes_match: hashesMatch,
    temporary_worktree: options.temporaryWorktree ?? null,
    host_isolation: "unsupported",
    concerns: options.concerns ?? [...regression.concerns, "host_isolation_unsupported"],
    errors,
  };
}
