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

describe("SelfImproveRunner trusted capability gate", () => {
  it("does not ask to merge when the trusted gate fails", async () => {
    const { mainRoot, baseDir, store } = await setupGoal("blocked.txt");
    const asks: string[] = [];
    const runner = new SelfImproveRunner({
      mainRoot,
      worktreeBaseDir: baseDir,
      goalStore: store,
      verifierCommands: ["true"],
      forceCleanup: true,
      capabilityGate: {
        evaluate: async () => ({
          status: "FAIL",
          evalId: "eval-fail",
          concerns: [],
          errors: ["hidden regression"],
        }),
      },
      ask: async (question) => {
        asks.push(question);
        return true;
      },
    });
    const result = await runner.runOnce();
    expect(result?.capabilityGate?.status).toBe("FAIL");
    expect(result?.merge).toEqual({ asked: false, reason: "capability_gate_fail" });
    expect(asks).toEqual([]);
    await expect(readFile(path.join(mainRoot, "blocked.txt"), "utf8")).rejects.toThrow();
  });

  it.each([
    {
      name: "returns INFRA_ERROR",
      evaluate: async () => ({ status: "INFRA_ERROR" as const, concerns: [], errors: ["provider unavailable"] }),
    },
    {
      name: "throws",
      evaluate: async () => {
        throw new Error("controller crashed");
      },
    },
  ])("fails closed without asking when the trusted gate $name", async ({ evaluate }) => {
    const { mainRoot, baseDir, store } = await setupGoal("infra.txt");
    let asked = false;
    const result = await new SelfImproveRunner({
      mainRoot,
      worktreeBaseDir: baseDir,
      goalStore: store,
      verifierCommands: ["true"],
      forceCleanup: true,
      capabilityGate: { evaluate },
      ask: async () => {
        asked = true;
        return true;
      },
    }).runOnce();
    expect(result?.capabilityGate?.status).toBe("INFRA_ERROR");
    expect(result?.merge).toEqual({ asked: false, reason: "capability_gate_infra" });
    expect(asked).toBe(false);
  });

  it("allows only an ask, never auto-merge, after a trusted PASS", async () => {
    const { mainRoot, baseDir, store } = await setupGoal("candidate.txt");
    const asks: string[] = [];
    const runner = new SelfImproveRunner({
      mainRoot,
      worktreeBaseDir: baseDir,
      goalStore: store,
      verifierCommands: ["true"],
      forceCleanup: true,
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
    });
    const result = await runner.runOnce();
    expect(result?.capabilityGate?.status).toBe("PASS");
    expect(result?.merge).toEqual({ asked: true, approved: false });
    expect(asks[0]).toMatch(/trusted capability gate green/i);
    await expect(readFile(path.join(mainRoot, "candidate.txt"), "utf8")).rejects.toThrow();
  });

  it("uses the conservative no-ask policy for PASS_WITH_CONCERNS", async () => {
    const { mainRoot, baseDir, store } = await setupGoal("concern.txt");
    let asked = false;
    const result = await new SelfImproveRunner({
      mainRoot,
      worktreeBaseDir: baseDir,
      goalStore: store,
      verifierCommands: ["true"],
      forceCleanup: true,
      capabilityGate: {
        evaluate: async () => ({
          status: "PASS_WITH_CONCERNS",
          concerns: ["usage unavailable"],
          errors: [],
        }),
      },
      ask: async () => {
        asked = true;
        return true;
      },
    }).runOnce();
    expect(result?.merge).toEqual({ asked: false, reason: "capability_gate_concerns" });
    expect(asked).toBe(false);
  });
});

async function setupGoal(fileName: string): Promise<{
  mainRoot: string;
  baseDir: string;
  store: GoalStore;
}> {
  const mainRoot = await mkdtemp(path.join(os.tmpdir(), "xio-gate-main-"));
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-gate-wt-"));
  tempDirs.push(mainRoot, baseDir);
  await gitOk(mainRoot, ["init"]);
  await gitOk(mainRoot, ["config", "user.email", "xio@test"]);
  await gitOk(mainRoot, ["config", "user.name", "xio"]);
  await writeFile(path.join(mainRoot, "README.md"), "base\n", "utf8");
  await gitOk(mainRoot, ["add", "README.md"]);
  await gitOk(mainRoot, ["commit", "-m", "init"]);
  const store = new GoalStore({ loadBuiltinSeeds: false });
  store.addSeed({
    id: `gate-${fileName}`,
    source: "seed",
    title: "gate candidate",
    prompt: "gate candidate",
    scriptedChange: { path: fileName, content: "candidate\n" },
  });
  return { mainRoot, baseDir, store };
}
