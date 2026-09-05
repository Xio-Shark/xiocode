import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { candidateRevision } from "../../xio-eval/src/evidence.ts";
import { gitOk } from "../../xio-sandbox/src/git.ts";
import { WorktreeSandbox } from "../../xio-sandbox/src/worktree-sandbox.ts";
import { GoalStore } from "../src/goal-store.ts";
import { ImprovementRunService } from "../src/run-ledger/service.ts";
import { RunLedgerStore } from "../src/run-ledger/store.ts";
import { SelfImproveRunner } from "../src/self-improve-runner.ts";

import type { ImproveGoal } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function initGitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-ledger-main-"));
  tempDirs.push(root);
  await gitOk(root, ["init"]);
  await gitOk(root, ["config", "user.email", "xio@test"]);
  await gitOk(root, ["config", "user.name", "xio"]);
  await writeFile(path.join(root, "README.md"), "base\n", "utf8");
  await gitOk(root, ["add", "README.md"]);
  await gitOk(root, ["commit", "-m", "init"]);
  return root;
}

async function makeFixture(): Promise<Readonly<{
  mainRoot: string;
  baseDir: string;
  ledger: ImprovementRunService;
}>> {
  const mainRoot = await initGitRepo();
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-ledger-wt-"));
  const ledgerRoot = await mkdtemp(path.join(os.tmpdir(), "xio-ledger-runs-"));
  tempDirs.push(baseDir, ledgerRoot);
  const ledger = new ImprovementRunService({
    store: new RunLedgerStore({ root: path.join(ledgerRoot, "runs") }),
    revisionOf: candidateRevision,
  });
  return { mainRoot, baseDir, ledger };
}

function scriptedGoal(id: string, file: string): ImproveGoal {
  return {
    id,
    source: "queue",
    title: `write ${file}`,
    prompt: `write ${file}`,
    scriptedChange: { path: file, content: `${id}\n` },
  };
}

function makeRunner(options: Readonly<{
  mainRoot: string;
  baseDir: string;
  ledger: ImprovementRunService;
  goals?: readonly ImproveGoal[];
  verifierCommands?: readonly string[];
  ask?: (question: string) => Promise<boolean>;
  claimOptions?: Readonly<{ retryOf?: string; overrideReason?: string }>;
}>): SelfImproveRunner {
  const store = new GoalStore({ loadBuiltinSeeds: false });
  for (const goal of options.goals ?? []) {
    store.enqueue(goal);
  }
  return new SelfImproveRunner({
    mainRoot: options.mainRoot,
    goalStore: store,
    worktreeBaseDir: options.baseDir,
    verifierCommands: options.verifierCommands ?? ["true"],
    replaceVerifierCommands: true,
    forceCleanup: true,
    ask: options.ask ?? (async () => false),
    ledger: options.ledger,
    ...(options.claimOptions ? { claimOptions: options.claimOptions } : {}),
  });
}

describe("SelfImproveRunner with ledger", () => {
  it("records the full lifecycle with receipts and dedupes the next invocation", async () => {
    const { mainRoot, baseDir, ledger } = await makeFixture();
    const goal = scriptedGoal("goal-ledger", "feature.txt");

    const first = makeRunner({ mainRoot, baseDir, ledger, goals: [goal] });
    const result = await first.runOnce();
    expect(result?.runId).toBeDefined();
    expect(result?.merge).toEqual({ asked: true, approved: false });

    const state = await ledger.load(result!.runId!);
    expect(state.phase).toBe("terminal");
    expect(state.outcome).toBe("rejected");
    expect(state.evidence.verifier_receipt).toMatch(/^receipts\/verifier-/);
    expect(state.evidence.merge_receipt).toMatch(/^receipts\/merge-/);
    const { events } = await ledger.store.loadRun(result!.runId!);
    expect(events.map((event) => event.to)).toEqual([
      "candidate_ready",
      "applying",
      "verifying",
      "awaiting_merge",
      "terminal",
    ]);

    // Same goal again: claim is refused, goal skipped, no silent re-execution.
    const notices: string[] = [];
    const second = new SelfImproveRunner({
      mainRoot,
      goalStore: (() => {
        const store = new GoalStore({ loadBuiltinSeeds: false });
        store.enqueue(goal);
        return store;
      })(),
      worktreeBaseDir: baseDir,
      verifierCommands: ["true"],
      replaceVerifierCommands: true,
      forceCleanup: true,
      ask: async () => false,
      notify: (message) => notices.push(message),
      ledger,
    });
    const repeat = await second.runOnce();
    expect(repeat).toBeUndefined();
    expect(notices.join("\n")).toMatch(/Skipping goal goal-ledger.*use retry/s);
  });

  it("records verifier_red terminal with failure signature and supports retry lineage", async () => {
    const { mainRoot, baseDir, ledger } = await makeFixture();
    const goal = scriptedGoal("goal-red", "broken.txt");

    const runner = makeRunner({ mainRoot, baseDir, ledger, goals: [goal], verifierCommands: ["exit 1"] });
    const result = await runner.runOnce();
    const state = await ledger.load(result!.runId!);
    expect(state.outcome).toBe("verifier_red");
    expect(state.failure_signature).toBeTruthy();

    const retry = makeRunner({
      mainRoot,
      baseDir,
      ledger,
      goals: [goal],
      verifierCommands: ["exit 1"],
      claimOptions: { retryOf: result!.runId! },
    });
    const retryResult = await retry.runOnce();
    const retryState = await ledger.load(retryResult!.runId!);
    expect(retryState.attempt).toBe(2);
    expect(retryState.parent_run_id).toBe(result!.runId);
    // First attempt evidence remains untouched.
    expect((await ledger.load(result!.runId!)).outcome).toBe("verifier_red");
  });

  it("resumes an interrupted apply by verifying the worktree as-is (no agent replay)", async () => {
    const { mainRoot, baseDir, ledger } = await makeFixture();
    const resolvedRoot = await WorktreeSandbox.resolveMainRoot(mainRoot);
    const goal = scriptedGoal("goal-resume", "resumed.txt");

    // Simulate a run killed mid-apply: claim + worktree + applying, then stop.
    const baseRevision = (await gitOk(resolvedRoot, ["rev-parse", "HEAD"])).trim();
    const commonDir = path.resolve(
      resolvedRoot,
      (await gitOk(resolvedRoot, ["rev-parse", "--git-common-dir"])).trim(),
    );
    const handle = await ledger.claim({
      goal,
      repoId: WorktreeSandbox.repoId(resolvedRoot),
      commonDir,
      baseRevision,
    });
    const session = await WorktreeSandbox.create({
      mainRoot: resolvedRoot,
      baseDir,
      sessionId: "resume-test",
    });
    let state = await ledger.advance(handle.state, {
      to: "candidate_ready",
      reason: "worktree_created",
      candidate: {
        worktree_path: session.worktreePath,
        branch: session.branch,
        base_ref: session.baseRef,
        baseline_tree: session.baselineTree,
      },
    });
    state = await ledger.advance(state, { to: "applying", reason: "agent_apply_started" });
    // The "agent" wrote a partial change before the process died.
    await writeFile(path.join(session.worktreePath, "resumed.txt"), "partial but useful\n", "utf8");

    const asks: string[] = [];
    const resumer = makeRunner({
      mainRoot,
      baseDir,
      ledger,
      ask: async (question) => {
        asks.push(question);
        return false;
      },
    });
    const result = await resumer.resumeRun(handle.runId);
    expect(asks).toHaveLength(1);
    expect(result.merge).toEqual({ asked: true, approved: false });
    const finalState = await ledger.load(handle.runId);
    expect(finalState.outcome).toBe("rejected");
    // Worktree content was verified as-is; nothing merged into main.
    await expect(access(path.join(resolvedRoot, "resumed.txt"))).rejects.toThrow();
  });

  it("resume refuses a different repository and an unregistered worktree", async () => {
    const { mainRoot, baseDir, ledger } = await makeFixture();
    const resolvedRoot = await WorktreeSandbox.resolveMainRoot(mainRoot);
    const goal = scriptedGoal("goal-guard", "guard.txt");
    const baseRevision = (await gitOk(resolvedRoot, ["rev-parse", "HEAD"])).trim();
    const commonDir = path.resolve(
      resolvedRoot,
      (await gitOk(resolvedRoot, ["rev-parse", "--git-common-dir"])).trim(),
    );
    const handle = await ledger.claim({
      goal,
      repoId: WorktreeSandbox.repoId(resolvedRoot),
      commonDir,
      baseRevision,
    });
    const session = await WorktreeSandbox.create({
      mainRoot: resolvedRoot,
      baseDir,
      sessionId: "guard-test",
    });
    let state = await ledger.advance(handle.state, {
      to: "candidate_ready",
      reason: "worktree_created",
      candidate: {
        worktree_path: session.worktreePath,
        branch: session.branch,
        base_ref: session.baseRef,
        baseline_tree: session.baselineTree,
      },
    });
    state = await ledger.advance(state, { to: "applying", reason: "agent_apply_started" });

    // Wrong repository.
    const otherRepo = await initGitRepo();
    const wrongRepoRunner = makeRunner({ mainRoot: otherRepo, baseDir, ledger });
    await expect(wrongRepoRunner.resumeRun(handle.runId)).rejects.toThrow(/belongs to repository/);

    // Unregistered/removed worktree.
    await WorktreeSandbox.remove(session, { force: true });
    const sameRepoRunner = makeRunner({ mainRoot, baseDir, ledger });
    await expect(sameRepoRunner.resumeRun(handle.runId)).rejects.toThrow(/not registered|missing or replaced/);
  });

  it("abandon is terminal and refuses double-abandon", async () => {
    const { mainRoot, baseDir, ledger } = await makeFixture();
    const resolvedRoot = await WorktreeSandbox.resolveMainRoot(mainRoot);
    const goal = scriptedGoal("goal-abandon", "gone.txt");
    const handle = await ledger.claim({
      goal,
      repoId: WorktreeSandbox.repoId(resolvedRoot),
      commonDir: path.resolve(resolvedRoot, (await gitOk(resolvedRoot, ["rev-parse", "--git-common-dir"])).trim()),
      baseRevision: (await gitOk(resolvedRoot, ["rev-parse", "HEAD"])).trim(),
    });
    const runner = makeRunner({ mainRoot, baseDir, ledger });
    await runner.abandonRun(handle.runId, "operator gave up");
    const state = await ledger.load(handle.runId);
    expect(state.outcome).toBe("abandoned");
    await expect(runner.abandonRun(handle.runId, "again")).rejects.toThrow(/already terminal/);
  });
});
