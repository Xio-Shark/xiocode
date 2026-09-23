import path from "node:path";
import os from "node:os";

import { configDefaults, defineConfig } from "vitest/config";

// Default worker count is `cpus - 1`, and every worker spawns real child
// processes (git, PTY, sandbox). On a 10-logical / 4-performance-core machine
// that oversubscribed the box badly enough to time out git setup: the same
// suite took 976s and failed `session-delete.test.ts`, versus 18.6s green with
// the cap below. Peak throughput plateaus well before `cpus - 1` here.
const maxWorkers = Math.max(2, Math.min(4, os.availableParallelism() - 1));

export default defineConfig({
  test: {
    maxWorkers,
    // Each worker claims its own HOME; see vitest.setup.ts for why.
    setupFiles: ["./vitest.setup.ts"],
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
