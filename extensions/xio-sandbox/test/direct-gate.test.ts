import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { RollbackOperationResult, SnapshotRef } from "@xioflow/kernel";

import { KernelSession } from "../../../src/runtime/process/kernel-session.ts";
import { gitOk } from "../src/git.ts";
import { describeRollback, DirectRollbackGate } from "../src/direct-gate.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function initGitRepo(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "xio-direct-main-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await gitOk(root, ["init"]);
  await gitOk(root, ["config", "user.email", "xio@test"]);
  await gitOk(root, ["config", "user.name", "xio"]);
  await writeFile(path.join(root, "README.md"), "base\n", "utf8");
  await gitOk(root, ["add", "README.md"]);
  await gitOk(root, ["commit", "-m", "init"]);
  return root;
}

async function openKernel(workspaceRoot: string, sessionId = "direct-gate"): Promise<KernelSession> {
  const domainPath = await mkdtemp(path.join(os.tmpdir(), "xio-direct-domain-"));
  const session = await KernelSession.open({ sessionId, workspaceRoot, domainPath });
  cleanups.push(async () => {
    session.close();
    await rm(domainPath, { recursive: true, force: true });
  });
  return session;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

describe("DirectRollbackGate (kernel snapshots)", () => {
  it("rolls back turn changes without losing pre-existing WIP or touching the user's index", async () => {
    const mainRoot = await initGitRepo();
    await writeFile(path.join(mainRoot, "user-wip.txt"), "important user work\n", "utf8");
    await writeFile(path.join(mainRoot, "staged.txt"), "staged by the user\n", "utf8");
    await gitOk(mainRoot, ["add", "staged.txt"]);
    await writeFile(path.join(mainRoot, "README.md"), "user modified\n", "utf8");
    const indexBefore = git(mainRoot, ["ls-files", "--stage"]);

    const gate = new DirectRollbackGate(await openKernel(mainRoot));
    await gate.initSessionBaseline();
    const checkpoint = await gate.captureTurnCheckpoint();
    expect(checkpoint.snapshot_id).toBeTruthy();
    expect(checkpoint.ref).toBe(`refs/xioflow/snapshots/${checkpoint.snapshot_id}`);
    expect(checkpoint.journal_seq).toBeGreaterThan(0);

    await writeFile(path.join(mainRoot, "README.md"), "agent broke this\n", "utf8");
    await writeFile(path.join(mainRoot, "agent-output.txt"), "agent generated file\n", "utf8");
    await writeFile(path.join(mainRoot, "报告.md"), "agent 中文文件\n", "utf8");

    const asked: string[] = [];
    const result = await gate.promptRollbackTurn(async (question) => {
      asked.push(question);
      return true;
    });
    expect(result).toMatchObject({ ok: true, skipped: false });
    expect(asked[0]).toContain("Discard 3 change(s)");
    expect(result.summary).toContain("Restored the turn checkpoint");
    // No manifest was taken (confinement is off), so nothing is claimed about ignored files.
    expect(result.summary).toContain("the kernel did not check whether they changed");
    expect(result.summary).not.toContain("unchanged");

    await expect(readFile(path.join(mainRoot, "README.md"), "utf8")).resolves.toBe("user modified\n");
    await expect(readFile(path.join(mainRoot, "user-wip.txt"), "utf8")).resolves.toBe("important user work\n");
    await expect(readFile(path.join(mainRoot, "agent-output.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(mainRoot, "报告.md"), "utf8")).rejects.toThrow();
    expect(git(mainRoot, ["ls-files", "--stage"])).toBe(indexBefore);
  });

  it("says when commands ran unconfined since the checkpoint", async () => {
    const mainRoot = await initGitRepo();
    const kernel = await openKernel(mainRoot);
    const gate = new DirectRollbackGate(kernel);
    await gate.initSessionBaseline();
    await gate.captureTurnCheckpoint();
    await kernel.run({
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('README.md', 'by a command\\n')"],
      cwd: mainRoot,
      output: { headBytes: 256, tailBytes: 0, hardCapBytes: 4096 },
    });

    const result = await gate.promptRollbackTurn(async () => true);
    expect(result.summary).toContain("effects outside the workspace");
    await expect(readFile(path.join(mainRoot, "README.md"), "utf8")).resolves.toBe("base\n");
  });

  it("keeps the baseline and the last retainTurns turn snapshots (rewind points)", async () => {
    const mainRoot = await initGitRepo();
    const kernel = await openKernel(mainRoot);
    const gate = new DirectRollbackGate(kernel, undefined, { retainTurns: 2 });
    await gate.initSessionBaseline();
    const first = await gate.captureTurnCheckpoint();
    const second = await gate.captureTurnCheckpoint();
    const third = await gate.captureTurnCheckpoint();

    expect(kernel.listSnapshotIds()).toHaveLength(3);
    expect(kernel.listSnapshotIds()).toEqual(expect.arrayContaining([second.snapshot_id, third.snapshot_id]));
    expect(gate.hasTurnSnapshot(first.snapshot_id)).toBe(false);
    expect(git(mainRoot, ["for-each-ref", `refs/xioflow/snapshots/${first.snapshot_id}`])).toBe("");

    // Rewinding to `second` forgets the turns after it.
    await gate.dropTurnSnapshotsAfter(second.snapshot_id);
    expect(gate.hasTurnSnapshot(third.snapshot_id)).toBe(false);
    expect(gate.turnCheckpoint?.snapshot_id).toBe(second.snapshot_id);
  });

  it("keeps an earlier launch's rewind snapshots when asked to at startup", async () => {
    const mainRoot = await initGitRepo();
    const kernel = await openKernel(mainRoot);
    const earlier = new DirectRollbackGate(kernel);
    await earlier.initSessionBaseline();
    const kept = await earlier.captureTurnCheckpoint();
    const dropped = await earlier.captureTurnCheckpoint();

    const gate = new DirectRollbackGate(kernel);
    await gate.initSessionBaseline([kept.snapshot_id]);
    expect(gate.hasTurnSnapshot(kept.snapshot_id)).toBe(true);
    expect(kernel.listSnapshotIds()).not.toContain(dropped.snapshot_id);
  });

  it("restores the session baseline", async () => {
    const mainRoot = await initGitRepo();
    const gate = new DirectRollbackGate(await openKernel(mainRoot));
    await gate.initSessionBaseline();
    await gate.captureTurnCheckpoint();
    await writeFile(path.join(mainRoot, "README.md"), "turn 1\n", "utf8");
    await gate.captureTurnCheckpoint();
    await writeFile(path.join(mainRoot, "README.md"), "turn 2\n", "utf8");

    const result = await gate.promptRollback(async () => true);
    expect(result.summary).toContain("Restored the session baseline");
    await expect(readFile(path.join(mainRoot, "README.md"), "utf8")).resolves.toBe("base\n");
    expect(gate.turnCheckpoint).toBeUndefined();
  });

  it("skips when nothing changed and when the user declines", async () => {
    const mainRoot = await initGitRepo();
    const gate = new DirectRollbackGate(await openKernel(mainRoot));
    await gate.captureTurnCheckpoint();

    const notifications: string[] = [];
    const unchanged = await gate.promptRollbackTurn(async () => true, (msg) => notifications.push(msg));
    expect(unchanged.skipped).toBe(true);
    expect(notifications[0]).toMatch(/No file changes/);

    await writeFile(path.join(mainRoot, "README.md"), "keep this\n", "utf8");
    const declined = await gate.promptRollbackTurn(async () => false);
    expect(declined.skipped).toBe(true);
    await expect(readFile(path.join(mainRoot, "README.md"), "utf8")).resolves.toBe("keep this\n");
  });

  it("explains that a checkpoint from a pre-kernel session cannot be rolled back to", async () => {
    const mainRoot = await initGitRepo();
    const gate = new DirectRollbackGate(await openKernel(mainRoot), {
      head: "abc", tree: "def", ref: "refs/xiocode/checkpoints/direct/x", commit: "123",
    });
    await expect(gate.promptRollbackTurn(async () => true)).rejects.toThrow(/older XioCode/);
  });
});

describe("describeRollback: ignored files", () => {
  const snapshot = { treeFingerprint: "a".repeat(40), coverage: "worktree_non_ignored" } as SnapshotRef;
  const rollback = (over: Partial<RollbackOperationResult>): RollbackOperationResult => ({
    kind: "rollback",
    status: "restored",
    snapshotId: "snap",
    coverage: "non_ignored",
    outOfScopeEffects: "none_possible",
    ignoredFiles: "not_captured",
    coverageBasis: ["all_ops_confined", "ignored_not_captured"],
    durationMs: 1,
    completedAt: "2026-09-30T00:00:00.000Z",
    ...over,
  });

  it("does not say ignored files are unchanged when the kernel never checked them", () => {
    const text = describeRollback(rollback({}), snapshot, "turn checkpoint");
    expect(text).toContain("were not snapshotted: the rollback did not restore them, and the kernel did not check whether they changed.");
    expect(text).not.toContain("unchanged");
    expect(text).not.toContain("complete");
    expect(text).toContain("everything except the ignored files");
  });

  it("lists ignored files that differ from the checkpoint", () => {
    const text = describeRollback(rollback({
      coverageBasis: ["all_ops_confined", "ignored_manifest_changed"],
      ignoredChanges: {
        added: ["/ws/cache.tmp"],
        removed: ["/ws/.env"],
        modified: ["/ws/build/out.js"],
        metadataOnly: ["/ws/build/kept.js"],
        truncated: true,
        counts: { added: 1, removed: 1, modified: 75, metadataOnly: 1 },
      },
    }), snapshot, "turn checkpoint");
    expect(text).toContain("Ignored files that differ from the checkpoint and were left as they are:");
    expect(text).toContain("  removed (1):\n    /ws/.env");
    expect(text).toContain("  added (1):\n    /ws/cache.tmp");
    expect(text).toContain("  modified (75):\n    /ws/build/out.js\n    ... and 74 more");
    expect(text).toContain("1 ignored file(s) kept their size and modification time");
    expect(text).not.toContain("did not check");
    expect(text).not.toContain("complete");
  });

  it("says unchanged only when the manifest proved it, and restored only when they were in the snapshot", () => {
    const verified = describeRollback(rollback({
      coverage: "complete",
      ignoredFiles: "unchanged_verified",
      coverageBasis: ["all_ops_confined", "ignored_manifest_unchanged"],
    }), snapshot, "turn checkpoint");
    expect(verified).toContain("found them unchanged");
    expect(verified).toContain("the kernel vouches for a complete rollback");

    const restored = describeRollback(rollback({
      coverage: "complete",
      ignoredFiles: "restored",
      coverageBasis: ["all_ops_confined", "snapshot_full_tree"],
    }), { ...snapshot, coverage: "full_tree" }, "turn checkpoint");
    expect(restored).toContain("were part of the snapshot and were restored with it");
  });

  it("lists new ignored files that a full snapshot's rollback left in place", () => {
    const text = describeRollback(rollback({
      status: "partial",
      coverage: "declared_roots",
      outOfScopeEffects: "possible",
      ignoredFiles: "restored",
      unrestoredPaths: ["/ws/node_modules/"],
      coverageBasis: ["unrestored_paths", "snapshot_full_tree"],
    }), { ...snapshot, coverage: "full_tree" }, "turn checkpoint");
    expect(text).toContain("these paths could not be restored:\n  /ws/node_modules/");
  });
});
