import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  MergeGate,
  WorktreeSandbox,
  defaultAsk,
  type AskFn,
  type WorktreeSession,
} from "../../xio-sandbox/src/index.ts";
import { GoalStore } from "./goal-store.ts";
import { Verifier } from "./verifier.ts";

import type {
  CapabilityGate,
  CapabilityGateResult,
  ImproveGoal,
  ImproveRunResult,
  MergeOutcome,
  VerifierResult,
} from "./types.ts";

export type ApplyGoalFn = (goal: ImproveGoal, worktreePath: string) => Promise<void>;

export type SelfImproveRunnerOptions = Readonly<{
  mainRoot: string;
  goalStore?: GoalStore;
  /** Worktree base dir (tests use temp). Default: ~/.xiocode/worktrees via sandbox. */
  worktreeBaseDir?: string;
  /** Verifier commands; default `npm run check`. */
  verifierCommands?: readonly string[];
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
}>;

/**
 * Self-improve outer loop.
 * Green verifier → MergeGate ask only. Never auto-merges (A1; G4 revoked).
 */
export class SelfImproveRunner {
  readonly #mainRoot: string;
  readonly #goalStore: GoalStore;
  readonly #worktreeBaseDir?: string;
  readonly #verifierCommands?: readonly string[];
  readonly #applyGoal: ApplyGoalFn;
  readonly #ask: AskFn;
  readonly #notify?: (message: string) => void;
  readonly #skipMergeAsk: boolean;
  readonly #forceCleanup: boolean;
  readonly #capabilityGate?: CapabilityGate;

  constructor(options: SelfImproveRunnerOptions) {
    this.#mainRoot = path.resolve(options.mainRoot);
    this.#goalStore = options.goalStore ?? new GoalStore();
    this.#worktreeBaseDir = options.worktreeBaseDir;
    this.#verifierCommands = options.verifierCommands;
    this.#ask = options.ask ?? defaultAsk;
    this.#notify = options.notify;
    this.#skipMergeAsk = options.skipMergeAsk === true;
    this.#forceCleanup = options.forceCleanup === true;
    this.#capabilityGate = options.capabilityGate;
    this.#applyGoal = options.applyGoal
      ?? createDefaultApplyGoal(options.spawnXio);
  }

  get goalStore(): GoalStore {
    return this.#goalStore;
  }

  async runOnce(): Promise<ImproveRunResult | undefined> {
    const goal = this.#goalStore.next();
    if (!goal) {
      this.#notify?.("No goals left in GoalStore (queue / red_test / seed).");
      return undefined;
    }

    await WorktreeSandbox.resolveMainRoot(this.#mainRoot);

    const session = await WorktreeSandbox.create({
      mainRoot: this.#mainRoot,
      baseDir: this.#worktreeBaseDir,
      sessionId: `improve-${goal.id}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40),
    });

    let merge: MergeOutcome | undefined;
    try {
      const outcome = await this.#executeGoal(goal, session);
      merge = outcome.merge;
      return {
        goal,
        worktreePath: session.worktreePath,
        ...outcome,
      };
    } finally {
      // Remove worktree after successful merge or when there is nothing left to keep.
      // Rejected ask / red verifier with dirty tree: retain for inspection (unless forceCleanup).
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
      } catch {
        // best-effort cleanup
      }
    }
  }

  async #executeGoal(
    goal: ImproveGoal,
    session: WorktreeSession,
  ): Promise<Pick<ImproveRunResult, "verifier" | "capabilityGate" | "merge">> {
    this.#notify?.(`Goal ${goal.id} (${goal.source}) in worktree ${session.worktreePath}`);
    await this.#applyGoal(goal, session.worktreePath);
    const verifier = await new Verifier({
      cwd: session.worktreePath,
      commands: this.#verifierCommands,
    }).run();
    this.#notify?.(
      verifier.ok
        ? `Verifier green for ${goal.id}`
        : `Verifier red for ${goal.id} (exit ${verifier.exitCode})`,
    );
    const capabilityGate = verifier.ok
      ? await this.#runCapabilityGate(goal, session.worktreePath)
      : undefined;
    const merge = await this.#maybeAskMerge(session, verifier, capabilityGate);
    return { verifier, capabilityGate, merge };
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

  async #maybeAskMerge(
    session: WorktreeSession,
    verifier: VerifierResult,
    capabilityGate?: CapabilityGateResult,
  ): Promise<MergeOutcome> {
    if (!verifier.ok) {
      return { asked: false, reason: "verifier_red" };
    }
    if (capabilityGate && capabilityGate.status !== "PASS") {
      return { asked: false, reason: gateReason(capabilityGate.status) };
    }
    if (this.#skipMergeAsk) {
      return { asked: false, reason: "skipped_by_policy" };
    }

    const gate = new MergeGate(session);
    const summary = await gate.summarize();
    if (!summary.hasChanges) {
      return { asked: false, reason: "no_changes" };
    }

    this.#notify?.(summary.text);
    const gateLabel = capabilityGate ? "Verifier and trusted capability gate green." : "Verifier green.";
    const approved = await this.#ask(`${gateLabel} Merge ${summary.filesChanged} change(s) from improve worktree into main tree? [y/N] `);
    if (!approved) {
      return { asked: true, approved: false };
    }

    const result = await gate.merge();
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
