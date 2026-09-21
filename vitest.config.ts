import path from "node:path";

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
    // The kernel process path is the default now, and it persists an execution
    // domain per session. Keep those domains inside the repo instead of the
    // developer's real ~/.xiocode (or $XIO_HOME).
    env: {
      XIOCODE_KERNEL_DOMAIN_ROOT: path.join(process.cwd(), ".vitest-kernel-domains"),
    },
  },
});
