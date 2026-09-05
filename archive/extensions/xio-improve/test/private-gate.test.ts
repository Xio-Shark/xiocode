import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitOk } from "../../xio-sandbox/src/git.ts";
import { GoalStore } from "../src/goal-store.ts";
import { SelfImproveRunner } from "../src/self-improve-runner.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("SelfImproveRunner private × capability joint gate", () => {
  it("asks only when private FIXED and capability PASS", async () => {
    const { mainRoot, baseDir, store } = await setupGoal("joint.txt");
    const asks: string[] = [];
    const result = await new SelfImproveRunner({
      mainRoot,
      worktreeBaseDir: baseDir,
      goalStore: store,
      verifierCommands: ["true"],
      replaceVerifierCommands: true,
      forceCleanup: true,
      privateCaseId: "case-1",
      privateGate: {
        evaluate: async () => ({
          status: "FIXED",
          caseId: "case-1",
          concerns: [],
          errors: [],
        }),
      },
      capabilityGate: {
        evaluate: async () => ({
          status: "PASS",
          evalId: "eval-pass",
          concerns: [],
          errors: [],
        }),
      },
      ask: async (question) => {
        asks.push(question);
        return false;
      },
    }).runOnce();

    expect(result?.privateGate?.status).toBe("FIXED");
    expect(result?.capabilityGate?.status).toBe("PASS");
    expect(result?.merge).toEqual({ asked: true, approved: false });
    expect(asks).toHaveLength(1);
    expect(asks[0]).toContain("private FIXED");
  });

  it("does not ask when private is FIXED but capability fails", async () => {
    const { mainRoot, baseDir, store } = await setupGoal("fixed-only.txt");
    let asked = false;
    const result = await new SelfImproveRunner({
      mainRoot,
      worktreeBaseDir: baseDir,
      goalStore: store,
      verifierCommands: ["true"],
      replaceVerifierCommands: true,
      forceCleanup: true,
      privateCaseId: "case-1",
      privateGate: {
        evaluate: async () => ({
          status: "FIXED",
          caseId: "case-1",
          concerns: [],
          errors: [],
        }),
      },
      capabilityGate: {
        evaluate: async () => ({
          status: "FAIL",
          evalId: "eval-fail",
          concerns: [],
          errors: ["hidden"],
        }),
      },
      ask: async () => {
        asked = true;
        return true;
      },
    }).runOnce();

    expect(result?.merge).toEqual({ asked: false, reason: "capability_gate_fail" });
    expect(asked).toBe(false);
    await expect(readFile(path.join(mainRoot, "fixed-only.txt"), "utf8")).rejects.toThrow();
  });

  it("does not ask when capability PASS but private is STILL_RED", async () => {
    const { mainRoot, baseDir, store } = await setupGoal("still-red.txt");
    let asked = false;
    const result = await new SelfImproveRunner({
      mainRoot,
      worktreeBaseDir: baseDir,
      goalStore: store,
      verifierCommands: ["true"],
      replaceVerifierCommands: true,
      forceCleanup: true,
      privateCaseId: "case-1",
      privateGate: {
        evaluate: async () => ({
          status: "STILL_RED",
          caseId: "case-1",
          concerns: [],
          errors: [],
        }),
      },
      capabilityGate: {
        evaluate: async () => ({
          status: "PASS",
          evalId: "eval-pass",
          concerns: [],
          errors: [],
        }),
      },
      ask: async () => {
        asked = true;
        return true;
      },
    }).runOnce();

    expect(result?.merge).toEqual({ asked: false, reason: "private_gate_still_red" });
    expect(asked).toBe(false);
  });

  it("fails closed when privateCaseId is set without capability gate", async () => {
    const { mainRoot, baseDir, store } = await setupGoal("need-cap.txt");
    let asked = false;
    const result = await new SelfImproveRunner({
      mainRoot,
      worktreeBaseDir: baseDir,
      goalStore: store,
      verifierCommands: ["true"],
      replaceVerifierCommands: true,
      forceCleanup: true,
      privateCaseId: "case-1",
      privateGate: {
        evaluate: async () => ({
          status: "FIXED",
          caseId: "case-1",
          concerns: [],
          errors: [],
        }),
      },
      ask: async () => {
        asked = true;
        return true;
      },
    }).runOnce();

    expect(result?.merge).toEqual({ asked: false, reason: "private_gate_requires_capability" });
    expect(asked).toBe(false);
  });
});

async function setupGoal(fileName: string): Promise<{
  mainRoot: string;
  baseDir: string;
  store: GoalStore;
}> {
  const mainRoot = await mkdtemp(path.join(os.tmpdir(), "xio-joint-main-"));
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-joint-wt-"));
  tempDirs.push(mainRoot, baseDir);
  await gitOk(mainRoot, ["init"]);
  await gitOk(mainRoot, ["config", "user.email", "xio@test"]);
  await gitOk(mainRoot, ["config", "user.name", "xio"]);
  await writeFile(path.join(mainRoot, "README.md"), "base\n", "utf8");
  await gitOk(mainRoot, ["add", "README.md"]);
  await gitOk(mainRoot, ["commit", "-m", "init"]);

  const store = new GoalStore({ loadBuiltinSeeds: false });
  store.addSeed({
    id: `joint-${fileName}`,
    source: "seed",
    title: "joint",
    prompt: "n/a",
    scriptedChange: { path: fileName, content: "patched\n" },
  });
  return { mainRoot, baseDir, store };
}
