import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default excludes miss `.claude/`, so vitest collected the full stale
    // repo copies under `.claude/worktrees/` — every git E2E test ran twice
    // and fought over git locks (REVIEW-2026-07-27 D5).
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    // The suite spawns real subprocesses and uses real sleeps; the 5s default
    // goes randomly red under load (REVIEW-2026-07-27 D2).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
