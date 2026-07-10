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
