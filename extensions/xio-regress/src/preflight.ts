import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { spawnCommand } from "../../xio-eval/src/process.ts";
import { git, gitOk } from "../../xio-sandbox/src/git.ts";
import { WorktreeSandbox } from "../../xio-sandbox/src/worktree-sandbox.ts";
import { RegressionCaseStore } from "./case-store.ts";
import { evidenceHashesMatch } from "./run-evidence-reader.ts";

import type { PrivateRegressionCase, PrivateRegressionPreflight, PreflightStatus } from "./types.ts";
import type { SpawnResult } from "../../xio-eval/src/process.ts";
import type { WorktreeSession } from "../../xio-sandbox/src/worktree-sandbox.ts";

type SourceSnapshot = Readonly<{ head: string; status: string }>;
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
      session = await WorktreeSandbox.create({
        mainRoot: regression.source.repo_root,
        baseDir: path.join(this.store.root, ".worktrees"),
        baseRef: regression.source.base_commit,
        sessionId: `regress-${randomUUID().slice(0, 12)}`,
      });
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

async function runVerifier(
  regression: PrivateRegressionCase,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  const shell = process.platform === "win32" ? "cmd.exe" : (env.SHELL ?? "/bin/sh");
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", regression.verifier.command]
    : ["-lc", regression.verifier.command];
  return spawnCommand({
    command: shell,
    args,
    cwd,
    env,
    timeoutMs: regression.verifier.timeout_ms,
    maxOutputBytes: 64 * 1024,
  });
}

async function sourceSnapshot(repoRoot: string): Promise<SourceSnapshot> {
  const [head, status] = await Promise.all([
    gitOk(repoRoot, ["rev-parse", "HEAD"]),
    gitOk(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  return { head, status };
}

async function assertBaseCommit(regression: PrivateRegressionCase): Promise<void> {
  const result = await git(regression.source.repo_root, [
    "cat-file",
    "-e",
    `${regression.source.base_commit}^{commit}`,
  ]);
  if (result.code !== 0) {
    throw new Error(`base commit is unavailable: ${regression.source.base_commit}`);
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

function verifierInfraErrors(outcome: SpawnResult): string[] {
  const errors: string[] = [];
  if (outcome.timedOut) errors.push("verifier timed out");
  if (outcome.cleanupError) errors.push(outcome.cleanupError);
  if (outcome.signal) errors.push(`verifier exited by signal ${outcome.signal}`);
  if (outcome.code === null) errors.push("verifier did not return an exit code");
  if (outcome.code === 126 || outcome.code === 127) errors.push("verifier command could not be executed");
  if (outcome.code !== null && outcome.code >= 128) errors.push("verifier process crashed");
  return errors;
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

async function cleanupWorktree(session: WorktreeSession): Promise<Readonly<{
  temporaryWorktree: string | null;
  errors: readonly string[];
}>> {
  try {
    await WorktreeSandbox.remove(session, { force: true });
    return { temporaryWorktree: null, errors: [] };
  } catch (error) {
    return {
      temporaryWorktree: session.worktreePath,
      errors: [`worktree cleanup failed: ${errorMessage(error)}`],
    };
  }
}

async function sourceUnchanged(repoRoot: string, before: SourceSnapshot): Promise<boolean> {
  const after = await sourceSnapshot(repoRoot).catch(() => null);
  return after !== null && snapshotsEqual(before, after);
}

function snapshotsEqual(left: SourceSnapshot, right: SourceSnapshot): boolean {
  return left.head === right.head && left.status === right.status;
}

function statusHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
