import { RegressionCaseStore } from "./case-store.ts";
import { evidenceHashesMatch } from "./run-evidence-reader.ts";
import {
  assertBaseCommit,
  cleanupWorktree,
  createPinnedBaseWorktree,
  errorMessage,
  resolveExistingDirectory,
  runVerifier,
  sourceSnapshot,
  sourceUnchanged,
  statusHash,
  verifierInfraErrors,
} from "./verifier-exec.ts";

import type {
  CompareInput,
  CompareStatus,
  PrivateRegressionCase,
  PrivateRegressionCompare,
} from "./types.ts";
import type { SpawnResult } from "../../xio-eval/src/process.ts";
import type { SourceSnapshot } from "./verifier-exec.ts";
import type { WorktreeSession } from "../../xio-sandbox/src/worktree-sandbox.ts";

type SideOutcome = Readonly<{
  root: string;
  outcome: SpawnResult | null;
  durationMs: number;
  errors: readonly string[];
}>;

export class RegressionCompare {
  private readonly store: RegressionCaseStore;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: Readonly<{ store?: RegressionCaseStore; env?: NodeJS.ProcessEnv }> = {}) {
    this.store = options.store ?? new RegressionCaseStore();
    this.env = options.env ?? process.env;
  }

  async evaluate(input: CompareInput): Promise<PrivateRegressionCompare> {
    const regression = await this.store.readCase(input.caseId);
    const hashesMatch = await evidenceHashesMatch(regression);
    if (!hashesMatch) {
      return this.persist(infraCompare({
        regression,
        hashesMatch: false,
        candidateRoot: input.candidateRoot,
        beforeRoot: input.beforeRoot ?? regression.source.base_commit,
        beforeKind: input.beforeRoot ? "explicit" : "pinned_base",
        errors: ["run artifact hash mismatch"],
      }));
    }

    let sourceBefore: SourceSnapshot;
    try {
      sourceBefore = await sourceSnapshot(regression.source.repo_root);
    } catch (error) {
      return this.persist(infraCompare({
        regression,
        hashesMatch: true,
        unchanged: false,
        candidateRoot: input.candidateRoot,
        beforeRoot: input.beforeRoot ?? regression.source.base_commit,
        beforeKind: input.beforeRoot ? "explicit" : "pinned_base",
        errors: [errorMessage(error)],
      }));
    }

    const concerns = compareConcerns(regression, sourceBefore);
    if (concerns.includes("source_dirty_state_changed_since_run")) {
      return this.persist(infraCompare({
        regression,
        hashesMatch: true,
        unchanged: true,
        concerns,
        candidateRoot: input.candidateRoot,
        beforeRoot: input.beforeRoot ?? regression.source.base_commit,
        beforeKind: input.beforeRoot ? "explicit" : "pinned_base",
        errors: ["source dirty state does not match recorded provenance"],
      }));
    }

    return this.runSides({ regression, input, sourceBefore, concerns });
  }

  private async runSides(options: Readonly<{
    regression: PrivateRegressionCase;
    input: CompareInput;
    sourceBefore: SourceSnapshot;
    concerns: readonly string[];
  }>): Promise<PrivateRegressionCompare> {
    const { regression, input, sourceBefore, concerns } = options;
    let pinnedSession: WorktreeSession | undefined;
    try {
      const before = await this.resolveBefore(regression, input.beforeRoot);
      pinnedSession = before.session;
      const candidateRoot = await resolveExistingDirectory(input.candidateRoot);
      const beforeSide = await this.executeSide(regression, before.root);
      const candidateSide = await this.executeSide(regression, candidateRoot);
      const cleanup = pinnedSession
        ? await cleanupWorktree(pinnedSession)
        : { temporaryWorktree: null, errors: [] as readonly string[] };
      const errors = [...beforeSide.errors, ...candidateSide.errors, ...cleanup.errors];
      const unchanged = await sourceUnchanged(regression.source.repo_root, sourceBefore);
      if (!unchanged) errors.push("source main changed during compare");
      return this.persist({
        schema_version: "private-regression-compare.v1",
        case_id: regression.case_id,
        status: classifyCompare({ regression, before: beforeSide, candidate: candidateSide, errors }),
        before: {
          root: before.root,
          kind: before.kind,
          actual_exit: beforeSide.outcome?.code ?? null,
          duration_ms: beforeSide.durationMs,
        },
        candidate: {
          root: candidateRoot,
          actual_exit: candidateSide.outcome?.code ?? null,
          duration_ms: candidateSide.durationMs,
        },
        source_main_unchanged: unchanged,
        artifact_hashes_match: true,
        temporary_worktree: cleanup.temporaryWorktree,
        host_isolation: "unsupported",
        concerns,
        errors,
      });
    } catch (error) {
      const cleanup = pinnedSession
        ? await cleanupWorktree(pinnedSession)
        : { temporaryWorktree: null, errors: [] as readonly string[] };
      const unchanged = await sourceUnchanged(regression.source.repo_root, sourceBefore);
      const errors = [errorMessage(error), ...cleanup.errors];
      if (!unchanged) errors.push("source main changed during compare");
      return this.persist(infraCompare({
        regression,
        hashesMatch: true,
        unchanged,
        concerns,
        candidateRoot: input.candidateRoot,
        beforeRoot: input.beforeRoot ?? regression.source.base_commit,
        beforeKind: input.beforeRoot ? "explicit" : "pinned_base",
        errors,
        temporaryWorktree: cleanup.temporaryWorktree ?? undefined,
      }));
    }
  }

  private async resolveBefore(
    regression: PrivateRegressionCase,
    beforeRoot: string | undefined,
  ): Promise<Readonly<{
    root: string;
    kind: "pinned_base" | "explicit";
    session?: WorktreeSession;
  }>> {
    if (beforeRoot) {
      return { root: await resolveExistingDirectory(beforeRoot), kind: "explicit" };
    }
    await assertBaseCommit(regression);
    const session = await createPinnedBaseWorktree(regression, this.store.root);
    return { root: session.worktreePath, kind: "pinned_base", session };
  }

  private async executeSide(regression: PrivateRegressionCase, cwd: string): Promise<SideOutcome> {
    const started = Date.now();
    try {
      const outcome = await runVerifier(regression, cwd, this.env);
      return { root: cwd, outcome, durationMs: Date.now() - started, errors: verifierInfraErrors(outcome) };
    } catch (error) {
      return { root: cwd, outcome: null, durationMs: Date.now() - started, errors: [errorMessage(error)] };
    }
  }

  private async persist(value: PrivateRegressionCompare): Promise<PrivateRegressionCompare> {
    await this.store.writeCompare(value);
    return value;
  }
}

function classifyCompare(options: Readonly<{
  regression: PrivateRegressionCase;
  before: SideOutcome;
  candidate: SideOutcome;
  errors: readonly string[];
}>): CompareStatus {
  if (options.errors.length > 0) return "INFRA_ERROR";
  const expected = options.regression.verifier.expected_exit;
  if (options.before.outcome?.code === expected) return "INVALID_CASE";
  if (options.candidate.outcome?.code === expected) return "FIXED";
  return "STILL_RED";
}

function compareConcerns(regression: PrivateRegressionCase, snapshot: SourceSnapshot): readonly string[] {
  const concerns = new Set(regression.concerns);
  concerns.add("host_isolation_unsupported");
  if (regression.source.dirty_summary_sha
    && regression.source.dirty_summary_sha !== statusHash(snapshot.status)) {
    concerns.add("source_dirty_state_changed_since_run");
  }
  return [...concerns].sort();
}

function infraCompare(options: Readonly<{
  regression: PrivateRegressionCase;
  hashesMatch: boolean;
  unchanged?: boolean;
  concerns?: readonly string[];
  candidateRoot: string;
  beforeRoot: string;
  beforeKind: "pinned_base" | "explicit";
  errors: readonly string[];
  temporaryWorktree?: string;
}>): PrivateRegressionCompare {
  const { regression, errors } = options;
  return {
    schema_version: "private-regression-compare.v1",
    case_id: regression.case_id,
    status: "INFRA_ERROR",
    before: {
      root: options.beforeRoot,
      kind: options.beforeKind,
      actual_exit: null,
      duration_ms: 0,
    },
    candidate: {
      root: options.candidateRoot,
      actual_exit: null,
      duration_ms: 0,
    },
    source_main_unchanged: options.unchanged ?? true,
    artifact_hashes_match: options.hashesMatch,
    temporary_worktree: options.temporaryWorktree ?? null,
    host_isolation: "unsupported",
    concerns: options.concerns ?? [...regression.concerns, "host_isolation_unsupported"],
    errors,
  };
}
