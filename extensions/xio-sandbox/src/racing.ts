import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { git } from "./git.ts";
import { MergeGate } from "./merge-gate.ts";
import { WorktreeSandbox } from "./worktree-sandbox.ts";

import type { DiffSummary, MergeResult } from "./merge-gate.ts";
import type { WorktreeSession } from "./worktree-sandbox.ts";

export type RaceCandidate<T = unknown> = Readonly<{
  id: string;
  name: string;
  description?: string;
  /**
   * Execute code changes or explorations inside the isolated worktree.
   */
  execute: (worktreePath: string) => Promise<T>;
}>;

export type RaceVerificationResult = Readonly<{
  passed: boolean;
  score?: number;
  details?: string;
}>;

export type RaceVerifier = (worktreePath: string) => Promise<RaceVerificationResult>;

export type RaceStrategy = "min_diff" | "fastest" | "highest_score";

export type RaceCandidateResult<T = unknown> = Readonly<{
  candidate: RaceCandidate<T>;
  worktreeSession: WorktreeSession;
  executed: boolean;
  executionTimeMs: number;
  verificationTimeMs: number;
  totalTimeMs: number;
  passed: boolean;
  diffSummary: DiffSummary;
  diffLines: number;
  output?: T;
  error?: string;
  verificationDetails?: string;
  score?: number;
}>;

export type RaceOutcome<T = unknown> = Readonly<{
  winner?: RaceCandidateResult<T>;
  allResults: readonly RaceCandidateResult<T>[];
  totalDurationMs: number;
  strategy: RaceStrategy;
}>;

export type RaceOptions = Readonly<{
  mainRoot: string;
  baseDir?: string;
  baseRef?: string;
  strategy?: RaceStrategy;
  timeoutMs?: number;
  /**
   * Whether to retain the winning worktree for inspection or merge.
   * Default is true. Losers are always cleaned up immediately.
   */
  retainWinnerWorktree?: boolean;
}>;

/**
 * Parses git diff --numstat output to calculate total changed lines (additions + deletions).
 */
export function parseNumstatLines(numstatOutput: string): number {
  let total = 0;
  for (const line of numstatOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const added = parts[0] === "-" ? 1 : Number.parseInt(parts[0], 10) || 0;
      const deleted = parts[1] === "-" ? 1 : Number.parseInt(parts[1], 10) || 0;
      total += added + deleted;
    }
  }
  return total;
}

/**
 * Runs speculative worktree racing across multiple candidates in parallel.
 * Each candidate executes in its own isolated git worktree.
 * All candidates are evaluated against the verifier.
 * The best candidate according to the strategy is selected as the winner,
 * and all losing/failed worktrees are automatically cleaned up.
 */
export async function runSpeculativeRace<T = unknown>(
  candidates: readonly RaceCandidate<T>[],
  verifier: RaceVerifier,
  options: RaceOptions,
): Promise<RaceOutcome<T>> {
  const strategy = options.strategy ?? "min_diff";
  const retainWinner = options.retainWinnerWorktree ?? true;
  const overallStart = performance.now();

  if (candidates.length === 0) {
    return {
      allResults: [],
      totalDurationMs: 0,
      strategy,
    };
  }

  // Execute all candidates concurrently in isolated worktrees
  const results = await Promise.all(
    candidates.map((candidate) => executeCandidateRace(candidate, verifier, options)),
  );

  // Evaluate winner from passing candidates
  const passingResults = results.filter((r) => r.passed);
  let winner: RaceCandidateResult<T> | undefined;

  if (passingResults.length > 0) {
    winner = pickWinner(passingResults, strategy);
  }

  // Garbage collect losing / failed worktrees
  const cleanupTasks: Promise<void>[] = [];
  for (const result of results) {
    const isWinner = winner && result.candidate.id === winner.candidate.id;
    if (!isWinner || !retainWinner) {
      cleanupTasks.push(
        WorktreeSandbox.remove(result.worktreeSession, { force: true }).catch(() => {}),
      );
    }
  }
  await Promise.all(cleanupTasks);

  const totalDurationMs = Math.round(performance.now() - overallStart);

  return {
    winner,
    allResults: results,
    totalDurationMs,
    strategy,
  };
}

async function executeCandidateRace<T>(
  candidate: RaceCandidate<T>,
  verifier: RaceVerifier,
  options: RaceOptions,
): Promise<RaceCandidateResult<T>> {
  const safeId = candidate.id.replaceAll(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  const sessionId = `race-${safeId}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;

  const session = await WorktreeSandbox.create({
    mainRoot: options.mainRoot,
    baseDir: options.baseDir,
    baseRef: options.baseRef,
    sessionId,
  });

  const execStart = performance.now();
  let executed = false;
  let output: T | undefined;
  let error: string | undefined;
  let executionTimeMs = 0;

  try {
    if (options.timeoutMs && options.timeoutMs > 0) {
      output = await withTimeout(
        candidate.execute(session.worktreePath),
        options.timeoutMs,
        `Candidate ${candidate.id} execution timed out after ${options.timeoutMs}ms`,
      );
    } else {
      output = await candidate.execute(session.worktreePath);
    }
    executed = true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  executionTimeMs = Math.round(performance.now() - execStart);

  // Summarize diff and changed lines
  const gate = new MergeGate(session);
  const diffSummary = await gate.summarize().catch(() => ({
    text: "(failed to get diff)",
    hasChanges: false,
    filesChanged: 0,
    uncommitted: false,
  }));

  const numstatResult = await git(session.worktreePath, [
    "diff",
    "--numstat",
    session.baselineTree,
  ]).catch(() => ({ stdout: "", stderr: "", code: 1 }));
  const diffLines = parseNumstatLines(numstatResult.stdout);

  // Verification stage
  const verStart = performance.now();
  let passed = false;
  let verificationDetails: string | undefined;
  let score: number | undefined;

  if (executed) {
    try {
      const vResult = options.timeoutMs && options.timeoutMs > 0
        ? await withTimeout(
            verifier(session.worktreePath),
            options.timeoutMs,
            `Candidate ${candidate.id} verification timed out after ${options.timeoutMs}ms`,
          )
        : await verifier(session.worktreePath);

      passed = vResult.passed;
      score = vResult.score;
      verificationDetails = vResult.details;
    } catch (verErr) {
      passed = false;
      verificationDetails = verErr instanceof Error ? verErr.message : String(verErr);
    }
  }
  const verificationTimeMs = Math.round(performance.now() - verStart);
  const totalTimeMs = executionTimeMs + verificationTimeMs;

  return {
    candidate,
    worktreeSession: session,
    executed,
    executionTimeMs,
    verificationTimeMs,
    totalTimeMs,
    passed,
    diffSummary,
    diffLines,
    output,
    error,
    verificationDetails,
    score,
  };
}

function pickWinner<T>(
  passing: readonly RaceCandidateResult<T>[],
  strategy: RaceStrategy,
): RaceCandidateResult<T> {
  const sorted = [...passing];

  switch (strategy) {
    case "min_diff": {
      // Smallest code diff lines first, tie-break by total time
      sorted.sort((a, b) => {
        if (a.diffLines !== b.diffLines) {
          return a.diffLines - b.diffLines;
        }
        return a.totalTimeMs - b.totalTimeMs;
      });
      break;
    }
    case "fastest": {
      // Lowest total latency first, tie-break by diff lines
      sorted.sort((a, b) => {
        if (a.totalTimeMs !== b.totalTimeMs) {
          return a.totalTimeMs - b.totalTimeMs;
        }
        return a.diffLines - b.diffLines;
      });
      break;
    }
    case "highest_score": {
      // Highest score first, tie-break by diff lines
      sorted.sort((a, b) => {
        const scoreA = a.score ?? 0;
        const scoreB = b.score ?? 0;
        if (scoreB !== scoreA) {
          return scoreB - scoreA;
        }
        return a.diffLines - b.diffLines;
      });
      break;
    }
  }

  return sorted[0]!;
}

/**
 * Merges the winner's worktree back into the main repository,
 * and cleans up the worktree afterwards.
 */
export async function applyRaceWinner<T = unknown>(
  outcome: RaceOutcome<T>,
  options: { removeWinnerWorktree?: boolean } = {},
): Promise<MergeResult> {
  if (!outcome.winner) {
    return {
      ok: false,
      conflict: false,
      error: "No winning candidate in race outcome to apply",
    };
  }

  const session = outcome.winner.worktreeSession;
  const gate = new MergeGate(session);
  const result = await gate.merge();

  if (options.removeWinnerWorktree !== false) {
    await WorktreeSandbox.remove(session, { force: true }).catch(() => {});
  }

  return result;
}

function withTimeout<R>(promise: Promise<R>, ms: number, timeoutMessage: string): Promise<R> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}
