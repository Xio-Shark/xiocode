import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitOk } from "../src/git.ts";
import { DirectRollbackGate } from "../src/direct-gate.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function initGitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-direct-main-"));
  tempDirs.push(root);
  await gitOk(root, ["init"]);
  await gitOk(root, ["config", "user.email", "xio@test"]);
  await gitOk(root, ["config", "user.name", "xio"]);
  await writeFile(path.join(root, "README.md"), "base\n", "utf8");
  await gitOk(root, ["add", "README.md"]);
  await gitOk(root, ["commit", "-m", "init"]);
  return root;
}

describe("DirectRollbackGate", () => {
  it("captures turn checkpoint and rolls back turn changes without losing pre-existing WIP", async () => {
    const mainRoot = await initGitRepo();

    // User has pre-existing uncommitted work before agent starts
    await writeFile(path.join(mainRoot, "user-wip.txt"), "important user work\n", "utf8");
    await writeFile(path.join(mainRoot, "README.md"), "user modified\n", "utf8");

    const gate = new DirectRollbackGate(mainRoot);
    await gate.initSessionBaseline();
    const checkpoint = await gate.captureTurnCheckpoint();

    expect(checkpoint.head).toBeDefined();
    expect(checkpoint.tree).toBeDefined();
    expect(checkpoint.ref).toMatch(/^refs\/xiocode\/checkpoints\/direct\//);

    // Agent makes changes during the turn: edits README.md and creates agent-output.txt
    await writeFile(path.join(mainRoot, "README.md"), "agent broke this\n", "utf8");
    await writeFile(path.join(mainRoot, "agent-output.txt"), "agent generated file\n", "utf8");

    // Ask returns true (approved)
    const result = await gate.promptRollbackTurn(async () => true);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);

    // Verify:
    // 1. README.md restored to "user modified\n" (the turn checkpoint state)
    await expect(readFile(path.join(mainRoot, "README.md"), "utf8")).resolves.toBe("user modified\n");
    // 2. Pre-existing WIP untouched
    await expect(readFile(path.join(mainRoot, "user-wip.txt"), "utf8")).resolves.toBe("important user work\n");
    // 3. Agent generated file removed
    await expect(readFile(path.join(mainRoot, "agent-output.txt"), "utf8")).rejects.toThrow();
  });

  it("skips rollback when no changes occurred", async () => {
    const mainRoot = await initGitRepo();
    const gate = new DirectRollbackGate(mainRoot);
    await gate.captureTurnCheckpoint();

    const notifications: string[] = [];
    const result = await gate.promptRollbackTurn(async () => true, (msg) => notifications.push(msg));

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(notifications[0]).toMatch(/No file changes/);
  });

  it("allows user rejection during promptRollbackTurn without mutating files", async () => {
    const mainRoot = await initGitRepo();
    const gate = new DirectRollbackGate(mainRoot);
    await gate.captureTurnCheckpoint();

    await writeFile(path.join(mainRoot, "README.md"), "keep this\n", "utf8");

    // Ask returns false (rejected)
    const result = await gate.promptRollbackTurn(async () => false);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);

    await expect(readFile(path.join(mainRoot, "README.md"), "utf8")).resolves.toBe("keep this\n");
  });
});
