import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitOk } from "../../xio-sandbox/src/git.ts";
import { ExternalEvalAdapter } from "../src/external-eval-adapter.ts";
import { GoalStore } from "../src/goal-store.ts";
import { SelfImproveRunner } from "../src/self-improve-runner.ts";
import { BUILTIN_SEEDS } from "../src/seeds.ts";
import { Verifier } from "../src/verifier.ts";

import type { ImproveGoal } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function initGitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-improve-main-"));
  tempDirs.push(root);
  await gitOk(root, ["init"]);
  await gitOk(root, ["config", "user.email", "xio@test"]);
  await gitOk(root, ["config", "user.name", "xio"]);
  await writeFile(path.join(root, "README.md"), "base\n", "utf8");
  await gitOk(root, ["add", "README.md"]);
  await gitOk(root, ["commit", "-m", "init"]);
  return root;
}

function goal(partial: Partial<ImproveGoal> & Pick<ImproveGoal, "id" | "source" | "title">): ImproveGoal {
  return {
    prompt: partial.prompt ?? partial.title,
    ...partial,
  };
}

describe("GoalStore T4 order", () => {
  it("drains queue before red_test before seed", () => {
    const store = new GoalStore({ loadBuiltinSeeds: false });
    store.addSeed(goal({ id: "s1", source: "seed", title: "seed" }));
    store.addRedTest(goal({ id: "r1", source: "red_test", title: "red" }));
    store.enqueue(goal({ id: "q1", source: "queue", title: "queue" }));

    expect(store.peekSource()).toBe("queue");
    expect(store.next()?.id).toBe("q1");
    expect(store.peekSource()).toBe("red_test");
    expect(store.next()?.id).toBe("r1");
    expect(store.peekSource()).toBe("seed");
    expect(store.next()?.id).toBe("s1");
    expect(store.next()).toBeUndefined();
  });

  it("loads at least one builtin S4 seed by default", () => {
    const store = new GoalStore();
    expect(BUILTIN_SEEDS.length).toBeGreaterThanOrEqual(1);
    expect(store.sizes().seed).toBeGreaterThanOrEqual(1);
    expect(store.next()?.id).toBe(BUILTIN_SEEDS[0]!.id);
  });
});

describe("ExternalEvalAdapter", () => {
  it("maps failure to a Goal that forbids merging external patches", () => {
    const adapter = new ExternalEvalAdapter();
    const g = adapter.toGoal({
      benchmark: "swe-bench-verified",
      instanceId: "django__django-12345",
      failureSummary: "agent failed to apply fix",
      externalPatchRef: "patches/django__django-12345.diff",
    });
    expect(g.source).toBe("external_eval");
    expect(g.id).toContain("swe-bench");
    expect(g.prompt).toMatch(/must NOT be merged/i);
    expect(g.meta?.instanceId).toBe("django__django-12345");
  });
});

describe("Verifier", () => {
  it("defaults to npm run check and reports red on failing command", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "xio-verify-"));
    tempDirs.push(cwd);
    const red = new Verifier({ cwd, commands: ["exit 1"], replaceDefault: true });
    const result = await red.run();
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);

    const green = new Verifier({ cwd, commands: ["true"], replaceDefault: true });
    expect((await green.run()).ok).toBe(true);
  });

  it("always prepends npm run check before extras", () => {
    const v = new Verifier({ cwd: process.cwd(), commands: ["npm test"] });
    expect(v.commands).toEqual(["npm run check", "npm test"]);
  });
});

describe("SelfImproveRunner", () => {
  it("does not ask merge when verifier is red", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-improve-wt-"));
    tempDirs.push(baseDir);

    const store = new GoalStore({ loadBuiltinSeeds: false });
    store.addSeed(goal({
      id: "red-seed",
      source: "seed",
      title: "write then fail check",
      scriptedChange: { path: "broken.txt", content: "x\n" },
    }));

    const asks: string[] = [];
    const runner = new SelfImproveRunner({
      mainRoot,
      goalStore: store,
      worktreeBaseDir: baseDir,
      verifierCommands: ["exit 1"],
      replaceVerifierCommands: true,
      forceCleanup: true,
      ask: async (q) => {
        asks.push(q);
        return true;
      },
    });

    const result = await runner.runOnce();
    expect(result).toBeDefined();
    expect(result!.verifier.ok).toBe(false);
    expect(result!.merge).toEqual({ asked: false, reason: "verifier_red" });
    expect(asks).toHaveLength(0);
    await expect(readFile(path.join(mainRoot, "broken.txt"), "utf8")).rejects.toThrow();
  });

  it("asks merge on green but leaves main tree unchanged when rejected", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-improve-wt-"));
    tempDirs.push(baseDir);

    const store = new GoalStore({ loadBuiltinSeeds: false });
    store.addSeed(goal({
      id: "reject-seed",
      source: "seed",
      title: "write feature",
      scriptedChange: { path: "feature.txt", content: "hello\n" },
    }));

    let asked = false;
    const runner = new SelfImproveRunner({
      mainRoot,
      goalStore: store,
      worktreeBaseDir: baseDir,
      verifierCommands: ["true"],
      replaceVerifierCommands: true,
      forceCleanup: true,
      ask: async () => {
        asked = true;
        return false;
      },
    });

    const result = await runner.runOnce();
    expect(result).toBeDefined();
    expect(result!.verifier.ok).toBe(true);
    expect(asked).toBe(true);
    expect(result!.merge).toEqual({ asked: true, approved: false });
    await expect(readFile(path.join(mainRoot, "feature.txt"), "utf8")).rejects.toThrow();
  });

  it("merges into main tree only after MergeGate approval", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-improve-wt-"));
    tempDirs.push(baseDir);

    const store = new GoalStore({ loadBuiltinSeeds: false });
    store.addSeed(goal({
      id: "approve-seed",
      source: "seed",
      title: "write feature",
      scriptedChange: { path: "feature.txt", content: "merged\n" },
    }));

    const runner = new SelfImproveRunner({
      mainRoot,
      goalStore: store,
      worktreeBaseDir: baseDir,
      verifierCommands: ["true"],
      replaceVerifierCommands: true,
      forceCleanup: true,
      ask: async () => true,
    });

    const result = await runner.runOnce();
    expect(result).toBeDefined();
    expect(result!.verifier.ok).toBe(true);
    expect(result!.merge.asked).toBe(true);
    expect(result!.merge).toMatchObject({ approved: true, merged: true });
    expect(await readFile(path.join(mainRoot, "feature.txt"), "utf8")).toBe("merged\n");
  });

  it("runLoop respects --max and T4 order", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-improve-wt-"));
    tempDirs.push(baseDir);

    const store = new GoalStore({ loadBuiltinSeeds: false });
    store.enqueue(goal({
      id: "q",
      source: "queue",
      title: "queue goal",
      scriptedChange: { path: "q.txt", content: "q\n" },
    }));
    store.addSeed(goal({
      id: "s",
      source: "seed",
      title: "seed goal",
      scriptedChange: { path: "s.txt", content: "s\n" },
    }));

    const runner = new SelfImproveRunner({
      mainRoot,
      goalStore: store,
      worktreeBaseDir: baseDir,
      verifierCommands: ["true"],
      replaceVerifierCommands: true,
      forceCleanup: true,
      ask: async () => false,
    });

    const results = await runner.runLoop({ max: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]!.goal.id).toBe("q");
    expect(store.peek()?.id).toBe("s");
  });
});
