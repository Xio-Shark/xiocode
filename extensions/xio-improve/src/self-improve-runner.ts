import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  MergeGate,
  WorktreeSandbox,
  defaultAsk,
  type AskFn,
  type WorktreeSession,
} from "../../xio-sandbox/src/index.ts";
import { gitOk } from "../../xio-sandbox/src/git.ts";
import { GoalStore } from "./goal-store.ts";
import {
  failureSignature,
  ImprovementRunService,
  LedgerClaimError,
} from "./run-ledger/service.ts";
import { Verifier } from "./verifier.ts";

import type { ImprovementRunState } from "./run-ledger/types.ts";
import type {
  CapabilityGate,
  CapabilityGateResult,
  ImproveGoal,
  ImproveRunResult,
  MergeOutcome,
  PrivateGate,
  PrivateGateResult,
  VerifierResult,
} from "./types.ts";

export type ApplyGoalFn = (goal: ImproveGoal, worktreePath: string) => Promise<void>;

/** Mutable holder threading the ledger-owned state through one run. */
type LedgerRunRef = {
  readonly ledger: ImprovementRunService;
  state: ImprovementRunState;
};

export type SelfImproveRunnerOptions = Readonly<{
  mainRoot: string;
  goalStore?: GoalStore;
  /** Worktree base dir (tests use temp). Default: ~/.xiocode/worktrees via sandbox. */
  worktreeBaseDir?: string;
  /**
   * Verifier extras after default `npm run check`, unless `replaceVerifierCommands`.
   * Production CLI passes `--check` extras here; tests may replace the full list.
   */
  verifierCommands?: readonly string[];
  /**
   * When true, `verifierCommands` is the full command list (no forced `npm run check`).
   * Tests only — production must keep the default gate.
   */
  replaceVerifierCommands?: boolean;
  /** Apply goal edits inside the worktree. Default: scriptedChange or spawn xio -p. */
  applyGoal?: ApplyGoalFn;
  ask?: AskFn;
  notify?: (message: string) => void;
  /** When true, skip MergeGate ask even if green (tests only). Default false. */
  skipMergeAsk?: boolean;
  /** When true, always remove the worktree in finally (tests). Default false. */
  forceCleanup?: boolean;
  spawnXio?: (prompt: string, worktreePath: string) => Promise<void>;
  /** Optional trusted before/after gate loaded outside the candidate worktree. */
  capabilityGate?: CapabilityGate;
  /** Optional private regression compare gate (requires capabilityGate for ask). */
  privateGate?: PrivateGate;
  /** Private case id when privateGate is set. */
  privateCaseId?: string;
  /**
   * Durable improvement-run ledger (claim/transition/receipt owner).
   * Production CLI always injects it; tests without it keep legacy behavior.
   */
  ledger?: ImprovementRunService;
  /** Claim options for the first goal (explicit retry lineage / override). */
  claimOptions?: Readonly<{ retryOf?: string; overrideReason?: string }>;
}>;

/**
 * Self-improve outer loop.
 * Green verifier → MergeGate ask only. Never auto-merges (A1; G4 revoked).
 * With privateCaseId: FIXED × trusted PASS required before ask.
 */
export class SelfImproveRunner {
  readonly #mainRoot: string;
  readonly #goalStore: GoalStore;
  readonly #worktreeBaseDir?: string;
  readonly #verifierCommands?: readonly string[];
  readonly #replaceVerifierCommands: boolean;
  readonly #applyGoal: ApplyGoalFn;
  readonly #ask: AskFn;
  readonly #notify?: (message: string) => void;
  readonly #skipMergeAsk: boolean;
  readonly #forceCleanup: boolean;
  readonly #capabilityGate?: CapabilityGate;
  readonly #privateGate?: PrivateGate;
  readonly #privateCaseId?: string;
  readonly #ledger?: ImprovementRunService;
  #claimOptions?: Readonly<{ retryOf?: string; overrideReason?: string }>;

  constructor(options: SelfImproveRunnerOptions) {
    this.#mainRoot = path.resolve(options.mainRoot);
    this.#goalStore = options.goalStore ?? new GoalStore();
    this.#worktreeBaseDir = options.worktreeBaseDir;
    this.#verifierCommands = options.verifierCommands;
    this.#replaceVerifierCommands = options.replaceVerifierCommands === true;
    this.#ask = options.ask ?? defaultAsk;
    this.#notify = options.notify;
    this.#skipMergeAsk = options.skipMergeAsk === true;
    this.#forceCleanup = options.forceCleanup === true;
    this.#capabilityGate = options.capabilityGate;
    this.#privateGate = options.privateGate;
    this.#privateCaseId = options.privateCaseId;
    this.#ledger = options.ledger;
    this.#claimOptions = options.claimOptions;
    this.#applyGoal = options.applyGoal
      ?? createDefaultApplyGoal(options.spawnXio);
  }

  get goalStore(): GoalStore {
    return this.#goalStore;
  }

  async runOnce(): Promise<ImproveRunResult | undefined> {
    // With a ledger, goals already claimed by another run are skipped
    // explicitly (R3.3) instead of silently re-executing.
    for (;;) {
      const goal = this.#goalStore.next();
      if (!goal) {
        this.#notify?.("No goals left in GoalStore (queue / red_test / seed).");
        return undefined;
      }
      let ref: LedgerRunRef | undefined;
      if (this.#ledger) {
        try {
          ref = { ledger: this.#ledger, state: (await this.#claimGoal(this.#ledger, goal)).state };
        } catch (error) {
          if (error instanceof LedgerClaimError) {
            this.#notify?.(`Skipping goal ${goal.id}: ${error.message}`);
            continue;
          }
          throw error;
        }
      }
      return this.#runGoal(goal, ref);
    }
  }

  async #claimGoal(
    ledger: ImprovementRunService,
    goal: ImproveGoal,
  ): Promise<Readonly<{ runId: string; state: ImprovementRunState }>> {
    const mainRoot = await WorktreeSandbox.resolveMainRoot(this.#mainRoot);
    const baseRevision = (await gitOk(mainRoot, ["rev-parse", "HEAD"])).trim();
    const commonDir = path.resolve(mainRoot, (await gitOk(mainRoot, ["rev-parse", "--git-common-dir"])).trim());
    const claimOptions = this.#claimOptions ?? {};
    // Retry lineage applies to the first claim only; later goals claim fresh.
    this.#claimOptions = undefined;
    return ledger.claim({
      goal,
      sourceRef: goal.meta?.queueFile ?? null,
      repoId: WorktreeSandbox.repoId(mainRoot),
      commonDir,
      baseRevision,
    }, claimOptions);
  }

  async #runGoal(goal: ImproveGoal, ref: LedgerRunRef | undefined): Promise<ImproveRunResult> {
    await WorktreeSandbox.resolveMainRoot(this.#mainRoot);

    const session = await WorktreeSandbox.create({
      mainRoot: this.#mainRoot,
      baseDir: this.#worktreeBaseDir,
      sessionId: `improve-${goal.id}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40),
    });
    if (ref) {
      ref.state = await ref.ledger.advance(ref.state, {
        to: "candidate_ready",
        reason: "worktree_created",
        candidate: {
          worktree_path: session.worktreePath,
          branch: session.branch,
          base_ref: session.baseRef,
          baseline_tree: session.baselineTree,
        },
      });
    }

    let merge: MergeOutcome | undefined;
    try {
      const outcome = await this.#executeGoal(goal, session, ref);
      merge = outcome.merge;
      return {
        goal,
        worktreePath: session.worktreePath,
        ...(ref ? { runId: ref.state.run_id } : {}),
        ...outcome,
      };
    } catch (error) {
      if (ref && ref.state.phase !== "terminal") {
        ref.state = await ref.ledger.terminate(ref.state, {
          outcome: "infra_error",
          reason: `unhandled_error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      throw error;
    } finally {
      try {
        const mergedOk = merge?.asked === true && merge.approved === true && merge.merged === true;
        if (
          this.#forceCleanup
          || mergedOk
          || await WorktreeSandbox.isMerged(session)
          || !(await WorktreeSandbox.hasUnmergedChanges(session))
        ) {
          await WorktreeSandbox.remove(session, { force: true });
        }
      } catch (error) {
        // Cleanup failure must be observable, not swallowed (R7.3).
        const detail = error instanceof Error ? error.message : String(error);
        this.#notify?.(`Worktree cleanup failed for ${session.worktreePath}: ${detail}`);
        if (ref) {
          await ref.ledger.store.appendDiagnostic(ref.state.run_id, {
            code: "worktree_cleanup_failed",
            detail,
          }).catch(() => {
            this.#notify?.(`Failed to persist cleanup diagnostic for run ${ref.state.run_id}`);
          });
        }
      }
    }
  }

  async #executeGoal(
    goal: ImproveGoal,
    session: WorktreeSession,
    ref: LedgerRunRef | undefined,
  ): Promise<Pick<ImproveRunResult, "verifier" | "capabilityGate" | "privateGate" | "merge">> {
    this.#notify?.(`Goal ${goal.id} (${goal.source}) in worktree ${session.worktreePath}`);
    if (ref) {
      ref.state = await ref.ledger.advance(ref.state, { to: "applying", reason: "agent_apply_started" });
    }
    await this.#applyGoal(goal, session.worktreePath);
    if (ref) {
      const revision = await ref.ledger.candidateRevision(session.worktreePath);
      ref.state = await ref.ledger.advance(ref.state, {
        to: "verifying",
        reason: "agent_apply_finished",
        candidate: { revision },
      });
    }
    return this.#verifyAndGate(goal, session, ref);
  }

  async runLoop(options: { max: number }): Promise<ImproveRunResult[]> {
    const max = Math.max(0, options.max);
    const results: ImproveRunResult[] = [];
    for (let i = 0; i < max; i += 1) {
      if (this.#goalStore.isEmpty()) {
        break;
      }
      const result = await this.runOnce();
      if (!result) {
        break;
      }
      results.push(result);
    }
    return results;
  }

  /**
   * Resume a nonterminal run (R5): validates repo/worktree/branch identity,
   * then continues from the recorded phase. Interrupted apply is completion
   * unknown — resume verifies the worktree as-is; it never replays the agent.
   */
  async resumeRun(runId: string): Promise<ImproveRunResult> {
    const ledger = this.#ledger;
    if (!ledger) {
      throw new Error("resume requires the improvement-run ledger");
    }
    const release = await ledger.store.acquireLock(runId);
    try {
      let state = await ledger.load(runId);
      if (state.phase === "terminal") {
        throw new Error(`run ${runId} is terminal (${state.outcome ?? "unknown"}); use retry for a new attempt`);
      }
      const session = await this.#rebuildSession(state);
      const ref: LedgerRunRef = { ledger, state };
      const goal: ImproveGoal = {
        id: state.goal.id,
        source: state.goal.source,
        title: state.goal.title,
        prompt: "",
      };

      if (ref.state.phase === "candidate_ready") {
        ref.state = await ledger.advance(ref.state, { to: "applying", reason: "resume_continue" });
      }
      if (ref.state.phase === "applying") {
        // Explicit operator decision: verify current worktree content as the candidate.
        const revision = await ledger.candidateRevision(session.worktreePath);
        ref.state = await ledger.advance(ref.state, {
          to: "verifying",
          reason: "resume_verify_as_candidate",
          candidate: { revision },
        });
      }

      if (ref.state.phase === "awaiting_merge") {
        const eligibility = await ledger.checkMergeEligibility(ref.state);
        if (eligibility.eligible) {
          const merge = await this.#finishMergeAsk(session, ref, "Resumed run; evidence fresh.", {}, undefined);
          return this.#resumeResult(goal, session, ref, merge);
        }
        this.#notify?.(`Evidence stale on resume: ${eligibility.staleReasons.join("; ")}`);
        ref.state = await ledger.advance(ref.state, {
          to: "verifying",
          reason: `stale_evidence: ${eligibility.staleReasons.join("; ")}`,
        });
      }

      // phase === verifying: re-run verifier, gates and merge flow.
      const outcome = await this.#verifyAndGate(goal, session, ref);
      return { goal, worktreePath: session.worktreePath, runId: ref.state.run_id, ...outcome };
    } finally {
      await release();
    }
  }

  /** Explicit abandon: terminal transition, worktree kept for inspection. */
  async abandonRun(runId: string, reason: string): Promise<void> {
    const ledger = this.#ledger;
    if (!ledger) {
      throw new Error("abandon requires the improvement-run ledger");
    }
    const release = await ledger.store.acquireLock(runId);
    try {
      const state = await ledger.load(runId);
      if (state.phase === "terminal") {
        throw new Error(`run ${runId} is already terminal (${state.outcome ?? "unknown"})`);
      }
      await ledger.terminate(state, { outcome: "abandoned", reason });
    } finally {
      await release();
    }
  }

  #resumeResult(
    goal: ImproveGoal,
    session: WorktreeSession,
    ref: LedgerRunRef,
    merge: MergeOutcome,
  ): ImproveRunResult {
    return {
      goal,
      worktreePath: session.worktreePath,
      runId: ref.state.run_id,
      verifier: { ok: true, commands: [], output: "(reused fresh verifier receipt)", exitCode: 0 },
      merge,
    };
  }

  /** Rebuild the WorktreeSession from ledger facts, failing closed on drift. */
  async #rebuildSession(state: ImprovementRunState): Promise<WorktreeSession> {
    const mainRoot = await WorktreeSandbox.resolveMainRoot(this.#mainRoot);
    const repoId = WorktreeSandbox.repoId(mainRoot);
    if (repoId !== state.repository.repo_id) {
      throw new Error(
        `run ${state.run_id} belongs to repository ${state.repository.repo_id}, current is ${repoId}`,
      );
    }
    const commonDir = path.resolve(mainRoot, (await gitOk(mainRoot, ["rev-parse", "--git-common-dir"])).trim());
    if (commonDir !== state.repository.common_dir) {
      throw new Error(
        `run ${state.run_id} common dir mismatch: recorded ${state.repository.common_dir}, current ${commonDir}`,
      );
    }
    const { worktree_path: worktreePath, branch, base_ref: baseRef, baseline_tree: baselineTree } = state.candidate;
    if (!worktreePath || !branch || !baseRef || !baselineTree) {
      throw new Error(`run ${state.run_id} has no complete candidate worktree record; abandon and re-run`);
    }
    const registered = await Promise.all(
      (await gitOk(mainRoot, ["worktree", "list", "--porcelain"]))
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => canonicalPath(line.slice("worktree ".length).trim())),
    );
    if (!registered.includes(await canonicalPath(worktreePath))) {
      throw new Error(
        `worktree ${worktreePath} is not registered in this repository (missing or replaced); repair or abandon`,
      );
    }
    const liveBranch = (await gitOk(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (liveBranch !== branch) {
      throw new Error(
        `worktree ${worktreePath} is on branch ${liveBranch}, run recorded ${branch}; refusing resume`,
      );
    }
    return {
      mainRoot,
      worktreePath,
      branch,
      sessionId: state.run_id,
      repoId,
      baseRef,
      baselineTree,
    };
  }

  /** Verifier + receipt + gates + merge flow shared by fresh runs and resume. */
  async #verifyAndGate(
    goal: ImproveGoal,
    session: WorktreeSession,
    ref: LedgerRunRef | undefined,
  ): Promise<Pick<ImproveRunResult, "verifier" | "capabilityGate" | "privateGate" | "merge">> {
    const revisionBefore = ref
      ? ref.state.candidate.revision ?? await ref.ledger.candidateRevision(session.worktreePath)
      : undefined;
    const startedAt = new Date().toISOString();
    const verifier = await new Verifier({
      cwd: session.worktreePath,
      commands: this.#verifierCommands,
      replaceDefault: this.#replaceVerifierCommands,
    }).run();
    this.#notify?.(
      verifier.ok
        ? `Verifier green for ${goal.id}`
        : `Verifier red for ${goal.id} (exit ${verifier.exitCode})`,
    );
    let verifierReceipt: string | undefined;
    if (ref && revisionBefore !== undefined) {
      const recorded = await ref.ledger.recordVerifierReceipt(ref.state, {
        worktreePath: session.worktreePath,
        revisionBefore,
        commands: verifier.commands,
        ok: verifier.ok,
        exitCode: verifier.exitCode,
        output: verifier.output,
        startedAt,
      });
      verifierReceipt = recorded.ref;
      if (recorded.revisionAfter !== ref.state.candidate.revision) {
        ref.state = await ref.ledger.advance(ref.state, {
          to: "verifying",
          kind: "note",
          reason: "candidate_revision_updated",
          candidate: { revision: recorded.revisionAfter },
        });
      }
      if (!verifier.ok) {
        ref.state = await ref.ledger.terminate(ref.state, {
          outcome: "verifier_red",
          reason: "verifier_red",
          failureSignature: failureSignature({
            goalFingerprint: ref.state.goal.fingerprint,
            baseRevision: ref.state.repository.base_revision,
            candidateRevision: recorded.revisionAfter,
            failureClass: "verifier_red",
            failedChecks: verifier.commands,
          }),
          evidence: { verifier_receipt: verifierReceipt },
        });
      }
    }
    const privateGate = verifier.ok
      ? await this.#runPrivateGate(session.worktreePath)
      : undefined;
    const capabilityGate = verifier.ok
      ? await this.#runCapabilityGate(goal, session.worktreePath)
      : undefined;
    const merge = await this.#maybeAskMerge(session, verifier, { capabilityGate, privateGate }, ref, verifierReceipt);
    return { verifier, capabilityGate, privateGate, merge };
  }

  async #maybeAskMerge(
    session: WorktreeSession,
    verifier: VerifierResult,
    gates: Readonly<{
      capabilityGate?: CapabilityGateResult;
      privateGate?: PrivateGateResult;
    }>,
    ref: LedgerRunRef | undefined,
    verifierReceipt: string | undefined,
  ): Promise<MergeOutcome> {
    if (!verifier.ok) {
      // Ledger already recorded terminal verifier_red in #executeGoal.
      return { asked: false, reason: "verifier_red" };
    }
    const gateEvidence = {
      ...(verifierReceipt ? { verifier_receipt: verifierReceipt } : {}),
      ...(gates.privateGate
        ? { private_case_id: gates.privateGate.caseId, private_status: gates.privateGate.status }
        : {}),
      ...(gates.capabilityGate
        ? {
          capability_status: gates.capabilityGate.status,
          ...(gates.capabilityGate.evalId ? { eval_id: gates.capabilityGate.evalId } : {}),
        }
        : {}),
    };
    const blocked = await this.#gateBlockReason(gates);
    if (blocked) {
      if (ref) {
        ref.state = await ref.ledger.terminate(ref.state, {
          outcome: "gate_blocked",
          reason: blocked,
          failureSignature: failureSignature({
            goalFingerprint: ref.state.goal.fingerprint,
            baseRevision: ref.state.repository.base_revision,
            candidateRevision: ref.state.candidate.revision,
            failureClass: "gate_blocked",
            failedChecks: [
              ...(gates.privateGate ? [`private:${gates.privateGate.status}`] : []),
              ...(gates.capabilityGate ? [`capability:${gates.capabilityGate.status}`] : []),
            ],
          }),
          evidence: gateEvidence,
        });
      }
      return { asked: false, reason: blocked };
    }
    if (this.#skipMergeAsk) {
      if (ref) {
        ref.state = await ref.ledger.terminate(ref.state, {
          outcome: "abandoned",
          reason: "skipped_by_policy",
          evidence: gateEvidence,
        });
      }
      return { asked: false, reason: "skipped_by_policy" };
    }

    const gateLabel = this.#privateCaseId
      ? "Verifier, private FIXED, and trusted capability PASS."
      : gates.capabilityGate
        ? "Verifier and trusted capability gate green."
        : "Verifier green.";
    return this.#finishMergeAsk(session, ref, gateLabel, gateEvidence, verifierReceipt);
  }

  /**
   * Shared merge-ask tail (fresh runs and resume): summarize, freshness gate,
   * MergeGate ask, receipts and terminal transition. Never auto-merges.
   */
  async #finishMergeAsk(
    session: WorktreeSession,
    ref: LedgerRunRef | undefined,
    gateLabel: string,
    gateEvidence: Partial<Record<"verifier_receipt" | "private_case_id" | "private_status" | "capability_status" | "eval_id", string>>,
    verifierReceipt: string | undefined,
  ): Promise<MergeOutcome> {
    const gate = new MergeGate(session);
    const summary = await gate.summarize();
    if (!summary.hasChanges) {
      if (ref) {
        ref.state = await ref.ledger.terminate(ref.state, {
          outcome: "no_changes",
          reason: "no_changes",
          evidence: gateEvidence,
        });
      }
      return { asked: false, reason: "no_changes" };
    }

    if (ref) {
      if (ref.state.phase !== "awaiting_merge") {
        ref.state = await ref.ledger.advance(ref.state, {
          to: "awaiting_merge",
          reason: "gates_green",
          evidence: gateEvidence,
          evidence_refs: verifierReceipt ? [verifierReceipt] : [],
        });
      }
      // Never ask with stale evidence: mismatch retreats to verifying (R4.3).
      const eligibility = await ref.ledger.checkMergeEligibility(ref.state);
      if (!eligibility.eligible) {
        this.#notify?.(`Merge ask blocked; stale evidence: ${eligibility.staleReasons.join("; ")}`);
        ref.state = await ref.ledger.advance(ref.state, {
          to: "verifying",
          reason: `stale_evidence: ${eligibility.staleReasons.join("; ")}`,
        });
        return { asked: false, reason: "stale_evidence" };
      }
    }

    this.#notify?.(summary.text);
    const approved = await this.#ask(`${gateLabel} Merge ${summary.filesChanged} change(s) from improve worktree into main tree? [y/N] `);
    if (!approved) {
      if (ref) {
        const receipt = await ref.ledger.recordMergeReceipt(ref.state, {
          candidateRevision: ref.state.candidate.revision ?? "unknown",
          asked: true,
          approved: false,
          merged: false,
          detail: "user rejected merge ask; main tree unchanged",
        });
        ref.state = await ref.ledger.terminate(ref.state, {
          outcome: "rejected",
          reason: "user_rejected",
          evidence: { merge_receipt: receipt },
        });
      }
      return { asked: true, approved: false };
    }

    const result = await gate.merge();
    if (ref) {
      const receipt = await ref.ledger.recordMergeReceipt(ref.state, {
        candidateRevision: ref.state.candidate.revision ?? "unknown",
        asked: true,
        approved: true,
        merged: result.ok,
        detail: result.ok ? result.summary : result.error,
      });
      ref.state = await ref.ledger.terminate(ref.state, {
        outcome: result.ok ? "merged" : "infra_error",
        reason: result.ok ? "merge_completed" : `merge_failed${result.conflict ? " (conflict)" : ""}`,
        evidence: { merge_receipt: receipt },
      });
    }
    if (result.ok) {
      this.#notify?.(result.summary);
      return { asked: true, approved: true, merged: true, summary: result.summary };
    }
    this.#notify?.(result.error);
    return {
      asked: true,
      approved: true,
      merged: false,
      error: result.error,
      conflict: result.conflict,
    };
  }

  async #gateBlockReason(gates: Readonly<{
    capabilityGate?: CapabilityGateResult;
    privateGate?: PrivateGateResult;
  }>): Promise<Extract<MergeOutcome, { asked: false }>["reason"] | undefined> {
    if (this.#privateCaseId) {
      if (!this.#capabilityGate) {
        return "private_gate_requires_capability";
      }
      const privateGate = gates.privateGate;
      if (!privateGate || privateGate.status !== "FIXED") {
        return privateGateReason(privateGate?.status);
      }
    }
    if (gates.capabilityGate && gates.capabilityGate.status !== "PASS") {
      return gateReason(gates.capabilityGate.status);
    }
    return undefined;
  }

  async #runPrivateGate(candidateRoot: string): Promise<PrivateGateResult | undefined> {
    if (!this.#privateGate || !this.#privateCaseId) {
      return undefined;
    }
    try {
      const result = await this.#privateGate.evaluate({
        caseId: this.#privateCaseId,
        candidateRoot,
      });
      this.#notify?.(`Private regression gate: ${result.status} (case=${result.caseId})`);
      if (result.status === "FIXED") {
        // Exam-pool growth hint: reskin the fixed real failure as a trusted fixture (human-reviewed).
        this.#notify?.(`Private case FIXED — consider drafting a trusted fixture: xio eval draft --private-case ${result.caseId}`);
      }
      for (const concern of result.concerns) {
        this.#notify?.(`Private concern: ${concern}`);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#notify?.(`Private regression gate: INFRA_ERROR (${message})`);
      return {
        status: "INFRA_ERROR",
        caseId: this.#privateCaseId,
        concerns: [],
        errors: [message],
      };
    }
  }

  async #runCapabilityGate(goal: ImproveGoal, candidateRoot: string): Promise<CapabilityGateResult | undefined> {
    if (!this.#capabilityGate) {
      return undefined;
    }
    try {
      const result = await this.#capabilityGate.evaluate({
        mainRoot: this.#mainRoot,
        candidateRoot,
        goal,
      });
      this.#notify?.(`Trusted capability gate: ${result.status}${result.evalId ? ` (${result.evalId})` : ""}`);
      for (const concern of result.concerns) {
        this.#notify?.(`Capability concern: ${concern}`);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#notify?.(`Trusted capability gate: INFRA_ERROR (${message})`);
      return { status: "INFRA_ERROR", concerns: [], errors: [message] };
    }
  }
}

/** Symlink-tolerant path identity (macOS /var vs /private/var). */
async function canonicalPath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function createDefaultApplyGoal(spawnXio?: (prompt: string, worktreePath: string) => Promise<void>): ApplyGoalFn {
  return async (goal, worktreePath) => {
    if (goal.scriptedChange) {
      const target = path.join(worktreePath, goal.scriptedChange.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, goal.scriptedChange.content, "utf8");
      return;
    }
    if (spawnXio) {
      await spawnXio(goal.prompt, worktreePath);
      return;
    }
    throw new Error(
      `Goal ${goal.id} has no scriptedChange; provide applyGoal or spawnXio to run the agent in the worktree.`,
    );
  };
}

function gateReason(status: CapabilityGateResult["status"]): Extract<MergeOutcome, { asked: false }>["reason"] {
  if (status === "FAIL") {
    return "capability_gate_fail";
  }
  if (status === "INFRA_ERROR") {
    return "capability_gate_infra";
  }
  return "capability_gate_concerns";
}

function privateGateReason(
  status: PrivateGateResult["status"] | undefined,
): Extract<MergeOutcome, { asked: false }>["reason"] {
  if (status === "STILL_RED") return "private_gate_still_red";
  if (status === "INFRA_ERROR") return "private_gate_infra";
  return "private_gate_invalid";
}
