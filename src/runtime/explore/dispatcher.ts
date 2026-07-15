/**
 * Explore dispatcher: role plans, early-stop, and frozen workspace-awareness scoring.
 * Keeps pure policy offline so deep vs fast can be evidenced without provider calls.
 */

import {
  aggregateWorkspaceBrief,
  type WorkerEvidenceReport,
  type WorkspaceBrief,
} from "./brief.ts";
import type { ExploreLane } from "./lanes.ts";
import { planExploreRoles, type RolePlan } from "./roles.ts";

/** Frozen multi-package awareness case used for deep-lane acceptance evidence. */
export type FrozenAwarenessCase = Readonly<{
  id: string;
  expected_paths: readonly string[];
  expected_symbols: readonly string[];
  questions: readonly string[];
}>;

/**
 * Synthetic cross-package case: auth + session + tests + middleware.
 * Deep lane must cover more of these targets than fast/standard under ownership simulation.
 */
export const FROZEN_AUTH_SESSION_AWARENESS: FrozenAwarenessCase = {
  id: "frozen-auth-session-impact.v1",
  expected_paths: [
    "src/auth/index.ts",
    "src/auth/session.ts",
    "src/runtime/session.ts",
    "src/runtime/session-store.ts",
    "tests/auth/session.test.ts",
    "packages/api/middleware/auth.ts",
  ],
  expected_symbols: [
    "createAuth",
    "SessionStore",
    "authMiddleware",
    "resumeSession",
  ],
  questions: [
    "where is auth entry?",
    "session lifecycle path?",
    "blast radius of SessionStore?",
    "what tests cover auth resume?",
  ],
};

export type AwarenessScore = Readonly<{
  path_coverage: number;
  symbol_coverage: number;
  /** Mean of path + symbol coverage (0–1). */
  evidence_coverage: number;
  covered_paths: readonly string[];
  covered_symbols: readonly string[];
  missing_paths: readonly string[];
  missing_symbols: readonly string[];
  gaps: readonly string[];
  role_count: number;
  overlap: number;
  citation_coverage: number;
}>;

export type DispatchPlan = Readonly<{
  lane: ExploreLane;
  roles: readonly RolePlan[];
  /** True when lane is fast → zero workers. */
  spawn: boolean;
}>;

/**
 * Build a role dispatch plan for the lane against path/question ownership.
 * Fast lane always returns empty roles (zero workers).
 */
export function planDispatch(
  lane: ExploreLane,
  paths: readonly string[],
  questions: readonly string[] = [],
): DispatchPlan {
  const roles = planExploreRoles(lane, paths, questions);
  return {
    lane,
    roles,
    spawn: roles.length > 0,
  };
}

/**
 * Score worker reports (or an aggregated brief) against a frozen awareness case.
 */
export function scoreAwarenessCoverage(
  reports: readonly WorkerEvidenceReport[],
  frozen: FrozenAwarenessCase,
): AwarenessScore {
  const brief = aggregateWorkspaceBrief(reports);
  return scoreBriefAgainstFrozen(brief, frozen, reports.length);
}

export function scoreBriefAgainstFrozen(
  brief: WorkspaceBrief,
  frozen: FrozenAwarenessCase,
  roleCount = 0,
): AwarenessScore {
  const citedPaths = new Set<string>();
  const claimText = brief.claims.map((claim) => claim.text).join("\n").toLowerCase();
  for (const claim of brief.claims) {
    for (const citation of claim.citations) {
      citedPaths.add(normalizePath(citation.path));
    }
  }

  const coveredPaths = frozen.expected_paths.filter((pathValue) =>
    pathCovered(pathValue, citedPaths)
  );
  const missingPaths = frozen.expected_paths.filter((pathValue) =>
    !pathCovered(pathValue, citedPaths)
  );
  const symbolSet = new Set(brief.symbols.map((s) => s.toLowerCase()));
  const coveredSymbols = frozen.expected_symbols.filter((symbol) =>
    symbolSet.has(symbol.toLowerCase())
    || claimText.includes(symbol.toLowerCase())
  );
  const missingSymbols = frozen.expected_symbols.filter((symbol) =>
    !coveredSymbols.includes(symbol)
  );

  const pathCoverage = frozen.expected_paths.length === 0
    ? 1
    : coveredPaths.length / frozen.expected_paths.length;
  const symbolCoverage = frozen.expected_symbols.length === 0
    ? 1
    : coveredSymbols.length / frozen.expected_symbols.length;
  const evidenceCoverage = (pathCoverage + symbolCoverage) / 2;

  return {
    path_coverage: pathCoverage,
    symbol_coverage: symbolCoverage,
    evidence_coverage: evidenceCoverage,
    covered_paths: coveredPaths,
    covered_symbols: coveredSymbols,
    missing_paths: missingPaths,
    missing_symbols: missingSymbols,
    gaps: [...brief.gaps, ...missingPaths.map((p) => `missing path: ${p}`)],
    role_count: roleCount,
    overlap: brief.overlap,
    citation_coverage: brief.citation_coverage,
  };
}

/**
 * Simulate faithful role reports under dispatcher ownership.
 * Each role only cites its owned paths (plus role-specific symbols/gaps).
 * Used for offline acceptance of deep > standard > fast coverage.
 */
/**
 * Simulate faithful role reports under dispatcher ownership.
 *
 * Capacity model (why deep beats standard):
 * each role only fully covers up to `maxPathsPerRole` owned paths within turn/output caps.
 * More specialized roles ⇒ higher aggregate path/symbol coverage on multi-package cases.
 */
export function simulateOwnedWorkerReports(
  plans: readonly RolePlan[],
  frozen: FrozenAwarenessCase,
  options: Readonly<{ maxPathsPerRole?: number }> = {},
): WorkerEvidenceReport[] {
  if (plans.length === 0) return [];

  const maxPathsPerRole = options.maxPathsPerRole ?? 2;
  const pathToSymbol = mapPathsToSymbols(frozen);
  return plans.map((plan) => {
    const ownedAll = plan.ownership.paths.length > 0
      ? plan.ownership.paths
      : pickFallbackPaths(plan.role.id, frozen.expected_paths);
    // Apply role capacity; leftover owned paths become explicit gaps (visible incompleteness).
    const owned = ownedAll.slice(0, maxPathsPerRole);
    const deferred = ownedAll.slice(maxPathsPerRole);

    const claims = owned.map((pathValue) => {
      const symbol = pathToSymbol.get(normalizePath(pathValue));
      return {
        text: symbol
          ? `${symbol} lives in ${pathValue}`
          : `relevant code in ${pathValue}`,
        confidence: 0.85,
        citations: [{ path: pathValue, start_line: 1, end_line: 40 }],
        source_role: plan.role.id,
      };
    });

    const symbols = owned
      .map((pathValue) => pathToSymbol.get(normalizePath(pathValue)))
      .filter((value): value is string => Boolean(value));

    const tests = plan.role.id === "impact_test"
      ? [...owned, ...deferred].filter((pathValue) => /test/i.test(pathValue))
      : [];

    // impact_test may still cite a test path even when capacity deferred it (blast-radius focus).
    if (plan.role.id === "impact_test") {
      for (const testPath of tests) {
        if (owned.some((p) => normalizePath(p) === normalizePath(testPath))) continue;
        claims.push({
          text: `test coverage surface at ${testPath}`,
          confidence: 0.8,
          citations: [{ path: testPath, start_line: 1, end_line: 20 }],
          source_role: plan.role.id,
        });
      }
    }

    const gaps: string[] = deferred.map((pathValue) => `capacity deferred: ${pathValue}`);
    if (plan.role.id === "adversarial") {
      const covered = new Set(claims.flatMap((claim) => claim.citations.map((c) => normalizePath(c.path))));
      for (const expected of frozen.expected_paths) {
        if (!covered.has(normalizePath(expected))) {
          gaps.push(`unowned or deferred target: ${expected}`);
        }
      }
      if (!tests.length && !owned.some((p) => /test/i.test(p))) {
        gaps.push("tests not scanned in this ownership slice");
      }
    }

    return {
      role: plan.role.id,
      claims,
      symbols: uniqueStrings([
        ...symbols,
        ...(plan.role.id === "impact_test" ? tests.map((p) => pathToSymbol.get(normalizePath(p))).filter(Boolean) as string[] : []),
      ]),
      tests,
      gaps,
    };
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

/**
 * Early-stop when recent coverage samples plateau (delta below epsilon for N samples).
 */
export function shouldEarlyStop(
  coverageHistory: readonly number[],
  options: Readonly<{ minSamples?: number; epsilon?: number }> = {},
): boolean {
  const minSamples = options.minSamples ?? 3;
  const epsilon = options.epsilon ?? 0.02;
  if (coverageHistory.length < minSamples) return false;
  const recent = coverageHistory.slice(-minSamples);
  const min = Math.min(...recent);
  const max = Math.max(...recent);
  return max - min <= epsilon;
}

/**
 * Cheap wall-time sample for lane selection (microseconds median of `iterations`).
 * Fast-lane decisions must stay negligible; used for non-regression evidence.
 */
export function sampleLaneSelectionCostUs(
  runOnce: () => void,
  iterations = 500,
): Readonly<{ median_us: number; p95_us: number; iterations: number }> {
  const samples: number[] = [];
  // Warm JIT once.
  runOnce();
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    runOnce();
    samples.push((performance.now() - start) * 1000);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length * 0.5)] ?? 0;
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] ?? 0;
  return {
    median_us: median,
    p95_us: p95,
    iterations,
  };
}

function pathCovered(expected: string, cited: ReadonlySet<string>): boolean {
  const norm = normalizePath(expected);
  if (cited.has(norm)) return true;
  for (const pathValue of cited) {
    if (pathMatches(norm, pathValue) || pathMatches(pathValue, norm)) return true;
  }
  return false;
}

function pathMatches(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  return na === nb || na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`) || na.includes(nb) || nb.includes(na);
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function mapPathsToSymbols(frozen: FrozenAwarenessCase): Map<string, string> {
  const map = new Map<string, string>();
  const symbols = frozen.expected_symbols;
  frozen.expected_paths.forEach((pathValue, index) => {
    const symbol = symbols[index % symbols.length];
    if (symbol) map.set(normalizePath(pathValue), symbol);
  });
  // Prefer stable mappings for known fixture paths.
  map.set(normalizePath("src/auth/index.ts"), "createAuth");
  map.set(normalizePath("src/runtime/session-store.ts"), "SessionStore");
  map.set(normalizePath("packages/api/middleware/auth.ts"), "authMiddleware");
  map.set(normalizePath("src/runtime/session.ts"), "resumeSession");
  return map;
}

function pickFallbackPaths(
  roleId: string,
  allPaths: readonly string[],
): string[] {
  if (allPaths.length === 0) return [];
  // Deterministic slice so roles still get disjoint-ish defaults when ownership empty.
  const offset = roleId.length % allPaths.length;
  return [allPaths[offset]!, allPaths[(offset + 1) % allPaths.length]!].filter(Boolean);
}
