import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { GoalStore } from "../../xio-improve/src/goal-store.ts";
import { SelfImproveRunner } from "../../xio-improve/src/self-improve-runner.ts";
import { MergeGate } from "../../xio-sandbox/src/merge-gate.ts";
import { WorktreeSandbox } from "../../xio-sandbox/src/worktree-sandbox.ts";
import { SecretRedactor } from "../../xio-evolve/src/secret-redactor.ts";
import { createBuiltinTools } from "../../../src/runtime/tools/builtin.ts";

export async function runRuntimeInvariants(options: Readonly<{
  fixtureRoot: string;
  worktreeRoot: string;
}>): Promise<readonly string[]> {
  const checks: string[] = [];
  await assertWriteContainment(options.fixtureRoot);
  checks.push("write/edit workspace containment rejects path escape");
  assertSecretRedaction();
  checks.push("trajectory secret redaction masks sensitive keys");
  await assertRejectedMergeLeavesMain(options.fixtureRoot, options.worktreeRoot);
  checks.push("rejected MergeGate leaves main tree unchanged");
  await assertRedVerifierSkipsAsk(options.fixtureRoot, options.worktreeRoot);
  checks.push("red verifier never asks to merge");
  return checks;
}

async function assertWriteContainment(root: string): Promise<void> {
  const write = createBuiltinTools({ cwd: root, workspaceRoot: root }).find((tool) => tool.name === "write");
  if (!write) {
    throw new Error("builtin write tool missing");
  }
  const outside = path.join(path.dirname(root), "escape.txt");
  const result = await write.execute("preflight", { path: outside, content: "escape" });
  const exists = await readFile(outside, "utf8").then(() => true).catch(() => false);
  if (result.isError !== true || exists) {
    throw new Error("workspace containment allowed a path escape");
  }
}

function assertSecretRedaction(): void {
  const redacted = new SecretRedactor().redact({
    api_key: "sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ12",
  }) as { api_key?: string };
  if (redacted.api_key !== "***REDACTED***") {
    throw new Error("secret redaction invariant failed");
  }
}

async function assertRejectedMergeLeavesMain(mainRoot: string, worktreeRoot: string): Promise<void> {
  const session = await WorktreeSandbox.create({
    mainRoot,
    baseDir: path.join(worktreeRoot, "merge-reject"),
    sessionId: "preflight-reject",
  });
  try {
    await writeFile(path.join(session.worktreePath, "candidate.txt"), "candidate\n", "utf8");
    const result = await new MergeGate(session).promptMerge(async () => false);
    const mainChanged = await readFile(path.join(mainRoot, "candidate.txt"), "utf8").then(() => true).catch(() => false);
    if (!("skipped" in result) || mainChanged) {
      throw new Error("rejected MergeGate changed main");
    }
  } finally {
    await WorktreeSandbox.remove(session, { force: true });
  }
}

async function assertRedVerifierSkipsAsk(mainRoot: string, worktreeRoot: string): Promise<void> {
  const goals = new GoalStore({ loadBuiltinSeeds: false });
  goals.addSeed({
    id: "preflight-red",
    source: "seed",
    title: "preflight red verifier",
    prompt: "preflight",
    scriptedChange: { path: "red.txt", content: "red\n" },
  });
  let asked = false;
  const result = await new SelfImproveRunner({
    mainRoot,
    goalStore: goals,
    worktreeBaseDir: path.join(worktreeRoot, "verifier-red"),
    verifierCommands: ["exit 1"],
    forceCleanup: true,
    ask: async () => {
      asked = true;
      return true;
    },
  }).runOnce();
  if (asked || result?.merge.asked !== false || result.merge.reason !== "verifier_red") {
    throw new Error("red verifier reached MergeGate ask");
  }
}
