import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitOk } from "../src/git.ts";
import { MergeGate } from "../src/merge-gate.ts";
import { WorktreeSandbox } from "../src/worktree-sandbox.ts";
import { registerXioSandbox } from "../src/index.ts";

import type { XioExtensionAPI } from "../../../src/runtime/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function initGitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-wt-main-"));
  tempDirs.push(root);
  await gitOk(root, ["init"]);
  await gitOk(root, ["config", "user.email", "xio@test"]);
  await gitOk(root, ["config", "user.name", "xio"]);
  await writeFile(path.join(root, "README.md"), "base\n", "utf8");
  await gitOk(root, ["add", "README.md"]);
  await gitOk(root, ["commit", "-m", "init"]);
  return root;
}

describe("WorktreeSandbox", () => {
  it("creates an isolated worktree under the configured base dir", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-base-"));
    tempDirs.push(baseDir);

    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "abc123" });
    expect(session.worktreePath).toBe(path.join(baseDir, session.repoId, "abc123"));
    expect(session.branch).toBe("xio/abc123");

    await writeFile(path.join(session.worktreePath, "only-worktree.txt"), "secret\n", "utf8");
    await expect(readFile(path.join(mainRoot, "only-worktree.txt"), "utf8")).rejects.toThrow();

    await WorktreeSandbox.remove(session, { force: true });
  });

  it("hard-fails resolveMainRoot outside a git repo", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-nongit-"));
    tempDirs.push(root);
    await expect(WorktreeSandbox.resolveMainRoot(root)).rejects.toThrow(/requires a git repository/i);
  });

  it("attaches only to the registered worktree with matching repository identity", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-base-"));
    tempDirs.push(baseDir);
    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "attach1" });

    await expect(WorktreeSandbox.attach(session, { baseDir })).resolves.toEqual(session);
    await expect(WorktreeSandbox.attach({ ...session, repoId: "wrong-repo" }, { baseDir }))
      .rejects.toThrow(/repo id mismatch/i);
    await expect(WorktreeSandbox.attach({ ...session, branch: "xio/wrong" }, { baseDir }))
      .rejects.toThrow(/expected branch/i);

    await WorktreeSandbox.remove(session, { force: true });
  });

  it("restores committed, tracked, untracked, and ignored files to the immutable session baseline", async () => {
    const mainRoot = await initGitRepo();
    await writeFile(path.join(mainRoot, ".gitignore"), "*.ignored\n", "utf8");
    await gitOk(mainRoot, ["add", ".gitignore"]);
    await gitOk(mainRoot, ["commit", "-m", "ignore fixture"]);
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-base-"));
    tempDirs.push(baseDir);
    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "rollback1" });
    const baseline = await gitOk(mainRoot, ["rev-parse", "HEAD"]);

    await writeFile(path.join(session.worktreePath, "README.md"), "committed session edit\n", "utf8");
    await writeFile(path.join(session.worktreePath, "committed.txt"), "committed\n", "utf8");
    await gitOk(session.worktreePath, ["add", "-A"]);
    await gitOk(session.worktreePath, ["commit", "-m", "session commit"]);
    await writeFile(path.join(session.worktreePath, "README.md"), "uncommitted session edit\n", "utf8");
    await writeFile(path.join(session.worktreePath, "untracked.txt"), "untracked\n", "utf8");
    await writeFile(path.join(session.worktreePath, "cache.ignored"), "ignored\n", "utf8");

    await writeFile(path.join(mainRoot, "main-only.txt"), "main\n", "utf8");
    await gitOk(mainRoot, ["add", "main-only.txt"]);
    await gitOk(mainRoot, ["commit", "-m", "advance main"]);
    const mainHead = await gitOk(mainRoot, ["rev-parse", "HEAD"]);

    expect(session.baseRef).toBe(baseline);
    await WorktreeSandbox.rollbackToSessionBaseline(session);

    expect(await gitOk(session.worktreePath, ["rev-parse", "HEAD"])).toBe(baseline);
    expect(await gitOk(session.worktreePath, ["status", "--short", "--ignored=matching"])).toBe("");
    expect(await readFile(path.join(session.worktreePath, "README.md"), "utf8")).toBe("base\n");
    await expect(readFile(path.join(session.worktreePath, "committed.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(session.worktreePath, "untracked.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(session.worktreePath, "cache.ignored"), "utf8")).rejects.toThrow();
    expect(await gitOk(mainRoot, ["rev-parse", "HEAD"])).toBe(mainHead);
    expect(await readFile(path.join(mainRoot, "main-only.txt"), "utf8")).toBe("main\n");

    await WorktreeSandbox.remove(session, { force: true });
  });

  it("restores the exact turn-start tree without changing the main tree", async () => {
    const mainRoot = await initGitRepo();
    await writeFile(path.join(mainRoot, ".gitignore"), "*.ignored\n", "utf8");
    await gitOk(mainRoot, ["add", ".gitignore"]);
    await gitOk(mainRoot, ["commit", "-m", "ignore fixture"]);
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-base-"));
    tempDirs.push(baseDir);
    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "turn1" });

    await writeFile(path.join(session.worktreePath, "README.md"), "before turn\n", "utf8");
    await writeFile(path.join(session.worktreePath, "existing.txt"), "keep me\n", "utf8");
    await writeFile(path.join(session.worktreePath, "cache.ignored"), "cached\n", "utf8");
    const checkpoint = await WorktreeSandbox.captureTurnCheckpoint(session);

    await writeFile(path.join(session.worktreePath, "README.md"), "during turn\n", "utf8");
    await rm(path.join(session.worktreePath, "existing.txt"));
    await writeFile(path.join(session.worktreePath, "created.txt"), "remove me\n", "utf8");
    await gitOk(session.worktreePath, ["add", "-A"]);
    await gitOk(session.worktreePath, ["commit", "-m", "turn commit"]);
    const summary = await WorktreeSandbox.summarizeSinceCheckpoint(session, checkpoint);
    expect(summary.hasChanges).toBe(true);
    expect(summary.filesChanged).toBe(3);

    const mainHead = await gitOk(mainRoot, ["rev-parse", "HEAD"]);
    await WorktreeSandbox.rollbackToTurnCheckpoint(session, checkpoint);

    expect(await readFile(path.join(session.worktreePath, "README.md"), "utf8")).toBe("before turn\n");
    expect(await readFile(path.join(session.worktreePath, "existing.txt"), "utf8")).toBe("keep me\n");
    expect(await readFile(path.join(session.worktreePath, "cache.ignored"), "utf8")).toBe("cached\n");
    await expect(readFile(path.join(session.worktreePath, "created.txt"), "utf8")).rejects.toThrow();
    expect(await gitOk(mainRoot, ["rev-parse", "HEAD"])).toBe(mainHead);

    await WorktreeSandbox.remove(session, { force: true });
  });

  it("keeps durable checkpoint trees reachable until the checkpoint ref is released", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-base-"));
    tempDirs.push(baseDir);
    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "durable1" });
    await writeFile(path.join(session.worktreePath, "README.md"), "checkpoint\n", "utf8");
    await writeFile(path.join(session.worktreePath, "untracked.txt"), "keep\n", "utf8");

    const checkpoint = await WorktreeSandbox.captureDurableCheckpoint(session, "turn1");
    expect(await gitOk(mainRoot, ["rev-parse", checkpoint.ref])).toBe(checkpoint.commit);
    await expect(WorktreeSandbox.validateCheckpoint(session, checkpoint)).resolves.toBeUndefined();
    await gitOk(mainRoot, ["gc", "--prune=now"]);
    expect(await gitOk(mainRoot, ["cat-file", "-e", `${checkpoint.tree}^{tree}`])).toBe("");

    await writeFile(path.join(session.worktreePath, "README.md"), "changed\n", "utf8");
    await rm(path.join(session.worktreePath, "untracked.txt"));
    await WorktreeSandbox.rollbackToTurnCheckpoint(session, checkpoint);
    expect(await readFile(path.join(session.worktreePath, "README.md"), "utf8")).toBe("checkpoint\n");
    expect(await readFile(path.join(session.worktreePath, "untracked.txt"), "utf8")).toBe("keep\n");

    await WorktreeSandbox.releaseCheckpoint(session, checkpoint);
    await expect(gitOk(mainRoot, ["rev-parse", "--verify", checkpoint.ref])).rejects.toThrow();
    await WorktreeSandbox.remove(session, { force: true });
  });
});

describe("MergeGate", () => {
  it("merges worktree changes into main after approval", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-base-"));
    tempDirs.push(baseDir);
    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "merge1" });
    await writeFile(path.join(session.worktreePath, "feature.txt"), "hello\n", "utf8");

    const gate = new MergeGate(session);
    const summary = await gate.summarize();
    expect(summary.hasChanges).toBe(true);

    const rejected = await gate.promptMerge(async () => false);
    expect("skipped" in rejected && rejected.skipped).toBe(true);
    await expect(readFile(path.join(mainRoot, "feature.txt"), "utf8")).rejects.toThrow();

    const merged = await gate.promptMerge(async () => true);
    expect(merged.ok).toBe(true);
    expect(await readFile(path.join(mainRoot, "feature.txt"), "utf8")).toBe("hello\n");

    await WorktreeSandbox.remove(session, { force: true });
  });

  it("discards worktree on session finalize reject", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-base-"));
    tempDirs.push(baseDir);
    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "end1" });
    await writeFile(path.join(session.worktreePath, "temp.txt"), "tmp\n", "utf8");

    const gate = new MergeGate(session);
    await gate.finalizeSession(async () => false, { retainOnReject: false });
    await expect(readFile(path.join(mainRoot, "temp.txt"), "utf8")).rejects.toThrow();
    const worktrees = await gitOk(mainRoot, ["worktree", "list", "--porcelain"]);
    expect(worktrees).not.toContain(session.worktreePath);
  });

  it("previews and confirms rollback without mutating files when rejected", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-base-"));
    tempDirs.push(baseDir);
    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "rollback2" });
    await writeFile(path.join(session.worktreePath, "README.md"), "changed\n", "utf8");
    await writeFile(path.join(session.worktreePath, "feature.txt"), "hello\n", "utf8");
    const gate = new MergeGate(session);
    const notices: string[] = [];

    const rejected = await gate.promptRollback(async () => false, (message) => notices.push(message));
    expect(rejected.skipped).toBe(true);
    expect(notices.join("\n")).toContain("diff --git");
    expect(notices.join("\n")).toContain("feature.txt");
    expect(await readFile(path.join(session.worktreePath, "feature.txt"), "utf8")).toBe("hello\n");

    const approved = await gate.promptRollback(async () => true);
    expect(approved.skipped).toBe(false);
    await expect(readFile(path.join(session.worktreePath, "feature.txt"), "utf8")).rejects.toThrow();
    expect((await gate.promptRollback(async () => {
      throw new Error("confirmation must not run for a clean worktree");
    })).skipped).toBe(true);

    await WorktreeSandbox.remove(session, { force: true });
  });

  it("previews and restores only changes made after the turn checkpoint", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-base-"));
    tempDirs.push(baseDir);
    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "rollbackturn" });
    await writeFile(path.join(session.worktreePath, "prior.txt"), "prior turn\n", "utf8");
    const gate = new MergeGate(session);
    await gate.captureTurnCheckpoint();
    await writeFile(path.join(session.worktreePath, "prior.txt"), "current turn\n", "utf8");
    await writeFile(path.join(session.worktreePath, "new.txt"), "new\n", "utf8");
    const notices: string[] = [];

    const result = await gate.promptRollbackTurn(async () => true, (message) => notices.push(message));

    expect(result.skipped).toBe(false);
    expect(notices.join("\n")).toContain("2 files changed");
    expect(await readFile(path.join(session.worktreePath, "prior.txt"), "utf8")).toBe("prior turn\n");
    await expect(readFile(path.join(session.worktreePath, "new.txt"), "utf8")).rejects.toThrow();
    await WorktreeSandbox.remove(session, { force: true });
  });
});

describe("registerXioSandbox", () => {
  it("registers sandbox status command", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-base-"));
    tempDirs.push(baseDir);
    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "reg1" });

    const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
    const api = {
      on() {},
      registerTool() {},
      registerCommand(name: string, options: { handler: (...args: unknown[]) => unknown }) {
        commands.set(name, options);
      },
      registerProvider() {},
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools() {},
      setModel: async () => true,
      getThinkingLevel: () => "off" as const,
      setThinkingLevel() {},
      model: undefined,
    } as unknown as XioExtensionAPI;

    registerXioSandbox(api, { session });
    expect(commands.has("sandbox")).toBe(true);
    const status = await commands.get("sandbox")!.handler();
    expect(String(status)).toContain(session.worktreePath);

    await WorktreeSandbox.remove(session, { force: true });
  });
});
