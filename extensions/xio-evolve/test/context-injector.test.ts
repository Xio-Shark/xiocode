import { describe, expect, it } from "vitest";

import { ContextInjector } from "../src/context-injector.ts";

describe("ContextInjector", () => {
  it("skips injection when the worktree is clean", async () => {
    const calls: string[] = [];
    const injector = new ContextInjector({
      exec: async (_command, args) => {
        calls.push(args.join(" "));
        if (args.includes("--branch")) return "## main\n";
        if (args.includes("--oneline")) return "abc init\n";
        return "";
      },
    });

    await expect(injector.inject()).resolves.toBe("");
    expect(calls).toEqual(["status --short --branch -- ."]);
  });

  it("limits git status and recent commits to the current workspace pathspec", async () => {
    const calls: string[] = [];
    const injector = new ContextInjector({
      exec: async (_command, args) => {
        calls.push(args.join(" "));
        if (args.includes("--branch")) return "## feature\n M README.md\n";
        if (args.includes("--oneline")) return "abc init\n";
        return "";
      },
    });

    await expect(injector.inject()).resolves.toContain("M README.md");
    expect(calls).toEqual(["status --short --branch -- .", "log --oneline -5 -- ."]);
  });

  it("collects branch and commits for clean worktrees without injecting them", async () => {
    const injector = new ContextInjector({
      exec: async (_command, args) => {
        if (args.includes("--branch")) return "## main\n";
        if (args.includes("--oneline")) return "abc init\n";
        return "";
      },
    });

    await expect(injector.inject()).resolves.toBe("");
    await expect(injector.collect()).resolves.toEqual({ branch: "main", status: "", recentCommits: "abc init" });
  });

  it("formats branch, status, and recent commits when changes exist", async () => {
    const injector = new ContextInjector({
      exec: async (_command, args) => {
        if (args.includes("--branch")) return "## feature...origin/feature\n M README.md\n";
        if (args.includes("--oneline")) return "abc init\n";
        return "";
      },
    });

    const injected = await injector.inject();

    expect(injected).toContain("## Project State");
    expect(injected).toContain("Branch: feature");
    expect(injected).toContain("M README.md");
  });

  it("truncates large worktree status injections with counts", async () => {
    const injector = new ContextInjector({
      maxStatusEntries: 2,
      exec: async (_command, args) => {
        if (args.includes("--branch")) return ["## feature", " M first.ts", " M second.ts", " M third.ts"].join("\n");
        if (args.includes("--oneline")) return "abc init\n";
        return "";
      },
    });

    const injected = await injector.inject();

    expect(injected).toContain("- Uncommitted (3, showing 2):");
    expect(injected).toContain("M first.ts");
    expect(injected).toContain("M second.ts");
    expect(injected).not.toContain("M third.ts");
    expect(injected).toContain("... (1 more changes)");
  });

  it("normalizes CRLF status entries while counting truncation exactly", async () => {
    const injector = new ContextInjector({
      maxStatusEntries: 1,
      exec: async (_command, args) => {
        if (args.includes("--branch")) return "## feature\r\n M first.ts\r\n\r\n M second.ts\r\n";
        if (args.includes("--oneline")) return "abc init\r\n";
        return "";
      },
    });

    const injected = await injector.inject();

    expect(injected).toContain("- Uncommitted (2, showing 1):");
    expect(injected).toContain("M first.ts");
    expect(injected).not.toContain("M second.ts");
    expect(injected).toContain("... (1 more changes)");
  });

  it("reuses injected context while the TTL is valid", async () => {
    let now = 1_000;
    const calls: string[] = [];
    const injector = new ContextInjector({
      ttlMs: 100,
      now: () => now,
      exec: async (_command, args) => {
        calls.push(args.join(" "));
        if (args.includes("--branch")) return "## feature\n M README.md\n";
        if (args.includes("--oneline")) return "abc init\n";
        return "";
      },
    });

    const first = await injector.inject();
    now = 1_050;
    const second = await injector.inject();

    expect(second).toBe(first);
    expect(calls).toEqual(["status --short --branch -- .", "log --oneline -5 -- ."]);
  });

  it("deduplicates concurrent context reads", async () => {
    const calls: string[] = [];
    let releaseStatus: (() => void) | undefined;
    const injector = new ContextInjector({
      exec: async (_command, args) => {
        calls.push(args.join(" "));
        if (args.includes("--branch")) {
          await new Promise<void>((resolve) => {
            releaseStatus = resolve;
          });
          return "## feature\n M README.md\n";
        }
        if (args.includes("--oneline")) return "abc init\n";
        return "";
      },
    });

    const first = injector.inject();
    const second = injector.inject();
    await waitForCondition(() => calls.includes("status --short --branch -- ."));
    releaseStatus?.();
    const [firstInjected, secondInjected] = await Promise.all([first, second]);

    expect(firstInjected).toBe(secondInjected);
    expect(calls).toEqual(["status --short --branch -- .", "log --oneline -5 -- ."]);
  });

  it("refreshes injected context after the TTL expires", async () => {
    let now = 1_000;
    let statusCalls = 0;
    const injector = new ContextInjector({
      ttlMs: 100,
      now: () => now,
      exec: async (_command, args) => {
        if (args.includes("--oneline")) return "abc init\n";
        statusCalls += 1;
        return statusCalls === 1 ? "## feature\n M first.md\n" : "## feature\n M second.md\n";
      },
    });

    const first = await injector.inject();
    now = 1_101;
    const second = await injector.inject();

    expect(first).toContain("first.md");
    expect(second).toContain("second.md");
    expect(statusCalls).toBe(2);
  });

  it("reuses recent commits while refreshing expired worktree status", async () => {
    let now = 1_000;
    let statusCalls = 0;
    let logCalls = 0;
    const injector = new ContextInjector({
      ttlMs: 100,
      now: () => now,
      exec: async (_command, args) => {
        if (args.includes("--oneline")) {
          logCalls += 1;
          return logCalls === 1 ? "abc init\n" : "def next\n";
        }
        statusCalls += 1;
        return statusCalls === 1 ? "## feature\n M first.md\n" : "## feature\n M second.md\n";
      },
    });

    const first = await injector.inject();
    now = 1_101;
    const second = await injector.inject();

    expect(first).toContain("first.md");
    expect(first).toContain("abc init");
    expect(second).toContain("second.md");
    expect(second).toContain("abc init");
    expect(second).not.toContain("def next");
    expect(statusCalls).toBe(2);
    expect(logCalls).toBe(1);
  });

  it("reloads recent commits when the branch changes", async () => {
    let now = 1_000;
    let statusCalls = 0;
    let logCalls = 0;
    const injector = new ContextInjector({
      ttlMs: 100,
      now: () => now,
      exec: async (_command, args) => {
        if (args.includes("--oneline")) {
          logCalls += 1;
          return logCalls === 1 ? "abc feature\n" : "def other\n";
        }
        statusCalls += 1;
        return statusCalls === 1 ? "## feature\n M first.md\n" : "## other\n M second.md\n";
      },
    });

    const first = await injector.inject();
    now = 1_101;
    const second = await injector.inject();

    expect(first).toContain("abc feature");
    expect(second).toContain("def other");
    expect(statusCalls).toBe(2);
    expect(logCalls).toBe(2);
  });

  it("returns expired cached context immediately when explicitly allowed and refreshes in the background", async () => {
    let now = 1_000;
    const statusReleases = new Map<number, () => void>();
    let statusCalls = 0;
    const injector = new ContextInjector({
      ttlMs: 100,
      now: () => now,
      exec: async (_command, args) => {
        if (args.includes("--oneline")) return "abc init\n";
        statusCalls += 1;
        const call = statusCalls;
        if (call > 1) {
          await new Promise<void>((resolve) => {
            statusReleases.set(call, resolve);
          });
        }
        return call === 1 ? "## feature\n M first.md\n" : "## feature\n M second.md\n";
      },
    });

    const first = await injector.inject();
    now = 1_101;
    const second = await injector.inject({ allowExpiredCache: true });
    await waitForCondition(() => statusCalls === 2);

    expect(first).toContain("first.md");
    expect(second).toBe(first);
    statusReleases.get(2)?.();
    await waitForCondition(() => statusReleases.size === 1);
    await expect(injector.inject()).resolves.toContain("second.md");
    expect(statusCalls).toBe(2);
  });

  it("returns empty context immediately when missing cache is allowed and refreshes in the background", async () => {
    let releaseStatus: (() => void) | undefined;
    let statusCalls = 0;
    const injector = new ContextInjector({
      exec: async (_command, args) => {
        if (args.includes("--oneline")) return "abc init\n";
        statusCalls += 1;
        await new Promise<void>((resolve) => {
          releaseStatus = resolve;
        });
        return "## feature\n M README.md\n";
      },
    });

    await expect(injector.inject({ allowMissingCache: true })).resolves.toBe("");
    expect(statusCalls).toBe(1);
    releaseStatus?.();
    await waitForCondition(() => releaseStatus !== undefined);
    await expect(injector.inject()).resolves.toContain("M README.md");
    expect(statusCalls).toBe(1);
  });

  it("does not return expired cached context after invalidation", async () => {
    let statusCalls = 0;
    const injector = new ContextInjector({
      ttlMs: 1_000,
      now: () => 1_000,
      exec: async (_command, args) => {
        if (args.includes("--oneline")) return "abc init\n";
        statusCalls += 1;
        return statusCalls === 1 ? "## feature\n M before.ts\n" : "## feature\n M after.ts\n";
      },
    });

    const first = await injector.inject();
    injector.invalidate();
    const second = await injector.inject({ allowExpiredCache: true });

    expect(first).toContain("before.ts");
    expect(second).toContain("after.ts");
    expect(statusCalls).toBe(2);
  });

  it("clears cached recent commits after invalidation", async () => {
    let logCalls = 0;
    let statusCalls = 0;
    const injector = new ContextInjector({
      ttlMs: 1_000,
      now: () => 1_000,
      exec: async (_command, args) => {
        if (args.includes("--oneline")) {
          logCalls += 1;
          return logCalls === 1 ? "abc before\n" : "def after\n";
        }
        statusCalls += 1;
        return statusCalls === 1 ? "## feature\n M before.ts\n" : "## feature\n M after.ts\n";
      },
    });

    const first = await injector.inject();
    injector.invalidate();
    const second = await injector.inject();

    expect(first).toContain("abc before");
    expect(second).toContain("def after");
    expect(logCalls).toBe(2);
  });

  it("refreshes injected context after invalidation even inside the TTL", async () => {
    let statusCalls = 0;
    const injector = new ContextInjector({
      ttlMs: 1_000,
      now: () => 1_000,
      exec: async (_command, args) => {
        if (args.includes("--oneline")) return "abc init\n";
        statusCalls += 1;
        return statusCalls === 1 ? "## feature\n M before.ts\n" : "## feature\n M after.ts\n";
      },
    });

    const first = await injector.inject();
    injector.invalidate();
    const second = await injector.inject();

    expect(first).toContain("before.ts");
    expect(second).toContain("after.ts");
    expect(statusCalls).toBe(2);
  });

  it("does not cache stale in-flight context after invalidation", async () => {
    const statusReleases = new Map<number, () => void>();
    let statusCalls = 0;
    const injector = new ContextInjector({
      ttlMs: 1_000,
      now: () => 1_000,
      exec: async (_command, args) => {
        if (args.includes("--oneline")) return "abc init\n";
        statusCalls += 1;
        const call = statusCalls;
        await new Promise<void>((resolve) => {
          statusReleases.set(call, resolve);
        });
        return call === 1 ? "## feature\n M before.ts\n" : "## feature\n M after.ts\n";
      },
    });

    const first = injector.inject();
    await waitForCondition(() => statusCalls === 1);
    injector.invalidate();
    const second = injector.inject();
    await waitForCondition(() => statusCalls === 2);

    statusReleases.get(2)?.();
    await expect(second).resolves.toContain("after.ts");
    statusReleases.get(1)?.();
    await expect(first).resolves.toContain("before.ts");
    await expect(injector.inject()).resolves.toContain("after.ts");
    expect(statusCalls).toBe(2);
  });

  it("skips injection outside git repositories", async () => {
    const injector = new ContextInjector({
      exec: async () => {
        const error = new Error("Command failed: git status --short");
        Object.assign(error, { stderr: "fatal: not a git repository (or any of the parent directories): .git" });
        throw error;
      },
    });

    await expect(injector.inject()).resolves.toBe("");
  });
});

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    if (condition()) {
      return;
    }
  }
}
