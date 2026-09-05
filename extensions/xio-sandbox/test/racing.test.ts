import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitOk } from "../src/git.ts";
import {
  applyRaceWinner,
  parseNumstatLines,
  runSpeculativeRace,
} from "../src/racing.ts";

import type { RaceCandidate } from "../src/racing.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function initGitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-race-repo-"));
  tempDirs.push(root);
  await gitOk(root, ["init"]);
  await gitOk(root, ["config", "user.email", "xio@test"]);
  await gitOk(root, ["config", "user.name", "xio"]);
  await writeFile(path.join(root, "math.ts"), "export function add(a: number, b: number) {\n  return 0;\n}\n", "utf8");
  await gitOk(root, ["add", "math.ts"]);
  await gitOk(root, ["commit", "-m", "init math"]);
  return root;
}

describe("parseNumstatLines", () => {
  it("computes total additions and deletions", () => {
    const sample = "10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts\n-\t-\timage.png\n";
    expect(parseNumstatLines(sample)).toBe(10 + 2 + 5 + 0 + 2);
  });

  it("handles empty or whitespace only input", () => {
    expect(parseNumstatLines("")).toBe(0);
    expect(parseNumstatLines("   \n\n  ")).toBe(0);
  });
});

describe("runSpeculativeRace", () => {
  it("handles empty candidate list", async () => {
    const outcome = await runSpeculativeRace([], async () => ({ passed: true }), {
      mainRoot: "/dummy",
      strategy: "min_diff",
    });
    expect(outcome.winner).toBeUndefined();
    expect(outcome.allResults).toHaveLength(0);
  });

  it("races multiple candidates in isolated worktrees and picks min_diff winner", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-race-wt-"));
    tempDirs.push(baseDir);

    // Candidate A: Correct fix but verbose (large diff)
    const candidateA: RaceCandidate = {
      id: "candA",
      name: "Verbose Fix",
      execute: async (wt) => {
        const verboseCode = [
          "export function add(a: number, b: number) {",
          "  // Detailed addition algorithm",
          "  const sum = a + b;",
          "  // Logging output",
          "  return sum;",
          "}",
          "",
        ].join("\n");
        await writeFile(path.join(wt, "math.ts"), verboseCode, "utf8");
      },
    };

    // Candidate B: Minimal surgical fix (1 line change)
    const candidateB: RaceCandidate = {
      id: "candB",
      name: "Surgical Fix",
      execute: async (wt) => {
        const conciseCode = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
        await writeFile(path.join(wt, "math.ts"), conciseCode, "utf8");
      },
    };

    // Candidate C: Broken fix (fails verification)
    const candidateC: RaceCandidate = {
      id: "candC",
      name: "Broken Fix",
      execute: async (wt) => {
        const brokenCode = "export function add(a: number, b: number) {\n  return a - b;\n}\n";
        await writeFile(path.join(wt, "math.ts"), brokenCode, "utf8");
      },
    };

    // Verifier: checks whether add(1, 2) === 3
    const verifier = async (wt: string) => {
      const content = await readFile(path.join(wt, "math.ts"), "utf8");
      const passed = content.includes("a + b");
      return { passed, details: passed ? "all tests passed" : "assertion failed" };
    };

    const outcome = await runSpeculativeRace(
      [candidateA, candidateB, candidateC],
      verifier,
      {
        mainRoot,
        baseDir,
        strategy: "min_diff",
        retainWinnerWorktree: true,
      },
    );

    expect(outcome.allResults).toHaveLength(3);
    const resultC = outcome.allResults.find((r) => r.candidate.id === "candC");
    expect(resultC?.passed).toBe(false);

    // Candidate B should win because it passes and has smaller diffLines than Candidate A
    expect(outcome.winner).toBeDefined();
    expect(outcome.winner?.candidate.id).toBe("candB");
    expect(outcome.winner?.passed).toBe(true);
    expect(outcome.winner?.diffLines).toBeLessThan(
      outcome.allResults.find((r) => r.candidate.id === "candA")!.diffLines,
    );

    // Loser worktrees (A and C) should have been pruned from git worktree list
    const worktreeList = await gitOk(mainRoot, ["worktree", "list", "--porcelain"]);
    const candAResult = outcome.allResults.find((r) => r.candidate.id === "candA")!;
    expect(worktreeList).not.toContain(candAResult.worktreeSession.worktreePath);
    expect(worktreeList).not.toContain(resultC!.worktreeSession.worktreePath);

    // Winner worktree should still exist because retainWinnerWorktree was true
    expect(worktreeList).toContain(outcome.winner!.worktreeSession.worktreePath);

    // Now apply winner to main
    const mergeRes = await applyRaceWinner(outcome, { removeWinnerWorktree: true });
    expect(mergeRes.ok).toBe(true);

    const mergedContent = await readFile(path.join(mainRoot, "math.ts"), "utf8");
    expect(mergedContent).toBe("export function add(a: number, b: number) {\n  return a + b;\n}\n");

    // After applying, winner worktree is also cleaned up
    const listAfter = await gitOk(mainRoot, ["worktree", "list", "--porcelain"]);
    expect(listAfter).not.toContain(outcome.winner!.worktreeSession.worktreePath);
  });

  it("selects fastest candidate when strategy is 'fastest'", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-race-fastest-"));
    tempDirs.push(baseDir);

    const candidateSlow: RaceCandidate = {
      id: "slow",
      name: "Slow candidate",
      execute: async (wt) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        await writeFile(path.join(wt, "math.ts"), "export function add() { return 1; }\n", "utf8");
      },
    };

    const candidateFast: RaceCandidate = {
      id: "fast",
      name: "Fast candidate",
      execute: async (wt) => {
        await writeFile(path.join(wt, "math.ts"), "export function add() { return 1; }\n", "utf8");
      },
    };

    const outcome = await runSpeculativeRace(
      [candidateSlow, candidateFast],
      async () => ({ passed: true }),
      {
        mainRoot,
        baseDir,
        strategy: "fastest",
        retainWinnerWorktree: false,
      },
    );

    expect(outcome.winner?.candidate.id).toBe("fast");
  });

  it("selects highest score candidate when strategy is 'highest_score'", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-race-score-"));
    tempDirs.push(baseDir);

    const candidate1: RaceCandidate = {
      id: "c1",
      name: "Candidate 1",
      execute: async (wt) => {
        await writeFile(path.join(wt, "math.ts"), "export function add() { return 1; }\n", "utf8");
      },
    };

    const candidate2: RaceCandidate = {
      id: "c2",
      name: "Candidate 2",
      execute: async (wt) => {
        await writeFile(path.join(wt, "math.ts"), "export function add() { return 2; }\n", "utf8");
      },
    };

    const outcome = await runSpeculativeRace(
      [candidate1, candidate2],
      async (wt) => {
        const content = await readFile(path.join(wt, "math.ts"), "utf8");
        const score = content.includes("2") ? 98 : 75;
        return { passed: true, score };
      },
      {
        mainRoot,
        baseDir,
        strategy: "highest_score",
        retainWinnerWorktree: false,
      },
    );

    expect(outcome.winner?.candidate.id).toBe("c2");
    expect(outcome.winner?.score).toBe(98);
  });

  it("handles candidate exceptions and timeouts cleanly", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-race-timeout-"));
    tempDirs.push(baseDir);

    const candidateThrow: RaceCandidate = {
      id: "throw",
      name: "Crashing candidate",
      execute: async () => {
        throw new Error("Syntax error in synthetic transformation");
      },
    };

    const candidateTimeout: RaceCandidate = {
      id: "timeout",
      name: "Hanging candidate",
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
    };

    const outcome = await runSpeculativeRace(
      [candidateThrow, candidateTimeout],
      async () => ({ passed: true }),
      {
        mainRoot,
        baseDir,
        timeoutMs: 40,
        retainWinnerWorktree: false,
      },
    );

    expect(outcome.winner).toBeUndefined();
    expect(outcome.allResults).toHaveLength(2);
    const throwResult = outcome.allResults.find((r) => r.candidate.id === "throw");
    expect(throwResult?.passed).toBe(false);
    expect(throwResult?.error).toContain("Syntax error in synthetic transformation");

    const timeoutResult = outcome.allResults.find((r) => r.candidate.id === "timeout");
    expect(timeoutResult?.passed).toBe(false);
    expect(timeoutResult?.error).toMatch(/timed out/i);
  });
});
