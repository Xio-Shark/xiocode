import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { MAX_EXPLORE_CONCURRENCY } from "./types.ts";

export type ExploreScaleTier = "tiny" | "small" | "medium" | "large" | "huge";

export type ExploreScaleEstimate = Readonly<{
  tier: ExploreScaleTier;
  /** Approximate source-like file count under the workspace (bounded scan). */
  fileCount: number;
  /** True when the walk hit the scan budget (count is a lower bound). */
  capped: boolean;
}>;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".xiocode",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  "venv",
]);

const SOURCE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".md",
  ".toml",
  ".yaml",
  ".yml",
  ".json",
]);

/** Stop walking after this many source-like files (latency bound). */
const MAX_SCAN_FILES = 4_000;
const MAX_SCAN_ENTRIES = 12_000;

/**
 * Cheap workspace scale probe for explore fan-out.
 * Counts source-like files under `root`, skipping heavy vendor trees.
 */
export async function estimateExploreScale(root: string): Promise<ExploreScaleEstimate> {
  let fileCount = 0;
  let entries = 0;
  let capped = false;
  const stack = [path.resolve(root)];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let listing: string[];
    try {
      listing = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of listing) {
      entries += 1;
      if (entries > MAX_SCAN_ENTRIES || fileCount >= MAX_SCAN_FILES) {
        capped = true;
        return { tier: tierForCount(fileCount, true), fileCount, capped };
      }
      if (name.startsWith(".") && name !== ".github") {
        // skip most dotdirs; .github may hold workflows worth counting lightly via files only
        if (name !== ".github") continue;
      }
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!info.isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      if (SOURCE_EXT.has(ext) || name === "Makefile" || name === "Dockerfile") {
        fileCount += 1;
      }
    }
  }

  return { tier: tierForCount(fileCount, false), fileCount, capped };
}

export function tierForCount(fileCount: number, capped: boolean): ExploreScaleTier {
  if (capped || fileCount >= 3_000) return "huge";
  if (fileCount >= 800) return "large";
  if (fileCount >= 150) return "medium";
  if (fileCount >= 30) return "small";
  return "tiny";
}

/**
 * Suggest how many explore workers to run for this scale.
 * Always ≤ maxConcurrency and ≤ MAX_EXPLORE_CONCURRENCY.
 * Default config (max=4) stays near 4 for medium+; raise max_concurrency for larger fan-out.
 */
export function suggestExploreConcurrency(
  estimate: ExploreScaleEstimate,
  maxConcurrency: number,
): number {
  const cap = Math.min(Math.max(1, maxConcurrency), MAX_EXPLORE_CONCURRENCY);
  const byTier: Record<ExploreScaleTier, number> = {
    tiny: 1,
    small: 2,
    medium: 4,
    large: 8,
    huge: 12,
  };
  return Math.min(byTier[estimate.tier], cap);
}
