import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KernelSession } from "../../../src/runtime/process/kernel-session.ts";
import { gitOk } from "../src/git.ts";
import { DirectRollbackGate } from "../src/direct-gate.ts";

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
    expect(result.summary).toContain("Ignored files");

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

  it("keeps only the baseline and the current turn's snapshot", async () => {
    const mainRoot = await initGitRepo();
    const kernel = await openKernel(mainRoot);
    const gate = new DirectRollbackGate(kernel);
    await gate.initSessionBaseline();
    const first = await gate.captureTurnCheckpoint();
    const second = await gate.captureTurnCheckpoint();

    expect(kernel.listSnapshotIds()).toHaveLength(2);
    expect(kernel.listSnapshotIds()).toContain(second.snapshot_id);
    expect(kernel.listSnapshotIds()).not.toContain(first.snapshot_id);
    expect(git(mainRoot, ["for-each-ref", `refs/xioflow/snapshots/${first.snapshot_id}`])).toBe("");
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
