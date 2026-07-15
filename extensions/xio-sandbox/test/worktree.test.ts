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

  it("syncs uncommitted main files into a new worktree", async () => {
    const mainRoot = await initGitRepo();
    await writeFile(path.join(mainRoot, "README.md"), "dirty tracked\n", "utf8");
    await writeFile(path.join(mainRoot, "scratch-untracked.txt"), "hello-untracked\n", "utf8");
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-base-"));
    tempDirs.push(baseDir);

    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "sync1" });
    await expect(readFile(path.join(session.worktreePath, "README.md"), "utf8")).resolves.toBe("dirty tracked\n");
    await expect(readFile(path.join(session.worktreePath, "scratch-untracked.txt"), "utf8"))
      .resolves.toBe("hello-untracked\n");
    // Main tree left unchanged by worktree edits path
    await expect(readFile(path.join(mainRoot, "README.md"), "utf8")).resolves.toBe("dirty tracked\n");

    await WorktreeSandbox.remove(session, { force: true });
  });

  it("hard-fails resolveMainRoot outside a git repo; tryResolve returns undefined", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-nongit-"));
    tempDirs.push(root);
    await expect(WorktreeSandbox.resolveMainRoot(root)).rejects.toThrow(/requires a git repository|Worktree mode requires/i);
    await expect(WorktreeSandbox.tryResolveMainRoot(root)).resolves.toBeUndefined();
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

describe("dirty baseline mirror + merge", () => {
  it("mirrors staged rename, symlink retarget, executable mode, delete, and untracked", async () => {
    const mainRoot = await initGitRepo();
    await writeFile(path.join(mainRoot, "old-name.txt"), "renamed-body\n", "utf8");
    await writeFile(path.join(mainRoot, "to-delete.txt"), "gone\n", "utf8");
    await writeFile(path.join(mainRoot, "script.sh"), "#!/bin/sh\necho hi\n", "utf8");
    await gitOk(mainRoot, ["add", "old-name.txt", "to-delete.txt", "script.sh"]);
    await gitOk(mainRoot, ["commit", "-m", "fixtures"]);
    // staged rename
    await gitOk(mainRoot, ["mv", "old-name.txt", "new-name.txt"]);
    // tracked delete (worktree)
    await rm(path.join(mainRoot, "to-delete.txt"));
    // executable mode on tracked file — chmod + index mode (import later with symlink)
    await (await import("node:fs/promises")).chmod(path.join(mainRoot, "script.sh"), 0o755);
    await gitOk(mainRoot, ["update-index", "--chmod=+x", "script.sh"]);
    // symlink retarget
    const { symlink, readlink, chmod } = await import("node:fs/promises");
    await symlink("README.md", path.join(mainRoot, "link-a"));
    await gitOk(mainRoot, ["add", "link-a"]);
    await gitOk(mainRoot, ["commit", "-m", "add symlink"]);
    await rm(path.join(mainRoot, "link-a"));
    await symlink("script.sh", path.join(mainRoot, "link-a"));
    // untracked
    await writeFile(path.join(mainRoot, "scratch-untracked.txt"), "u\n", "utf8");
    // ignored should NOT mirror
    await writeFile(path.join(mainRoot, ".gitignore"), "*.ignored\n", "utf8");
    await gitOk(mainRoot, ["add", ".gitignore"]);
    await gitOk(mainRoot, ["commit", "-m", "ignore"]);
    await writeFile(path.join(mainRoot, "secret.ignored"), "nope\n", "utf8");

    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-dirty-"));
    tempDirs.push(baseDir);
    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "dirty1" });

    await expect(readFile(path.join(session.worktreePath, "new-name.txt"), "utf8")).resolves.toBe("renamed-body\n");
    await expect(readFile(path.join(session.worktreePath, "old-name.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(session.worktreePath, "to-delete.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(session.worktreePath, "scratch-untracked.txt"), "utf8")).resolves.toBe("u\n");
    await expect(readFile(path.join(session.worktreePath, "secret.ignored"), "utf8")).rejects.toThrow();

    const mode = await gitOk(session.worktreePath, ["ls-files", "-s", "script.sh"]);
    expect(mode).toMatch(/^100755\s/);
    expect(await readlink(path.join(session.worktreePath, "link-a"))).toBe("script.sh");

    // session rollback restores launch WIP, not clean HEAD only
    await writeFile(path.join(session.worktreePath, "agent-edit.txt"), "agent\n", "utf8");
    await WorktreeSandbox.rollbackToSessionBaseline(session);
    await expect(readFile(path.join(session.worktreePath, "new-name.txt"), "utf8")).resolves.toBe("renamed-body\n");
    await expect(readFile(path.join(session.worktreePath, "scratch-untracked.txt"), "utf8")).resolves.toBe("u\n");
    await expect(readFile(path.join(session.worktreePath, "agent-edit.txt"), "utf8")).rejects.toThrow();

    await WorktreeSandbox.remove(session, { force: true });
  });

  it("mirrors when launched from a repository subdirectory", async () => {
    const mainRoot = await initGitRepo();
    const sub = path.join(mainRoot, "pkg", "inner");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, "nested.txt"), "nested-wip\n", "utf8");
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-sub-"));
    tempDirs.push(baseDir);
    // create uses mainRoot; capture still uses toplevel
    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "sub1" });
    await expect(readFile(path.join(session.worktreePath, "pkg/inner/nested.txt"), "utf8")).resolves.toBe("nested-wip\n");
    await WorktreeSandbox.remove(session, { force: true });
  });

  it("dirty merge keeps original index and only applies agent delta", async () => {
    const mainRoot = await initGitRepo();
    await writeFile(path.join(mainRoot, "staged.txt"), "staged-v1\n", "utf8");
    await writeFile(path.join(mainRoot, "unstaged.txt"), "unstaged-v1\n", "utf8");
    await gitOk(mainRoot, ["add", "staged.txt", "unstaged.txt"]);
    await gitOk(mainRoot, ["commit", "-m", "base files"]);
    // staged change
    await writeFile(path.join(mainRoot, "staged.txt"), "staged-v2\n", "utf8");
    await gitOk(mainRoot, ["add", "staged.txt"]);
    // unstaged change
    await writeFile(path.join(mainRoot, "unstaged.txt"), "unstaged-v2\n", "utf8");
    // untracked WIP
    await writeFile(path.join(mainRoot, "wip-untracked.txt"), "wip\n", "utf8");

    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-merge-dirty-"));
    tempDirs.push(baseDir);
    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "mdirty1" });
    expect(await WorktreeSandbox.isDirtyBaseline(session)).toBe(true);

    // agent only adds a new file
    await writeFile(path.join(session.worktreePath, "agent-only.txt"), "from-agent\n", "utf8");

    // capture main index tree before merge
    const indexBefore = await gitOk(mainRoot, ["write-tree"]);
    const statusBefore = await gitOk(mainRoot, ["status", "--porcelain"]);

    const gate = new MergeGate(session);
    const result = await gate.merge();
    expect(result.ok).toBe(true);

    // original staged content preserved in index
    const indexAfter = await gitOk(mainRoot, ["write-tree"]);
    expect(indexAfter).toBe(indexBefore);
    // agent file present on main working tree
    await expect(readFile(path.join(mainRoot, "agent-only.txt"), "utf8")).resolves.toBe("from-agent\n");
    // original WIP still present
    await expect(readFile(path.join(mainRoot, "staged.txt"), "utf8")).resolves.toBe("staged-v2\n");
    await expect(readFile(path.join(mainRoot, "unstaged.txt"), "utf8")).resolves.toBe("unstaged-v2\n");
    await expect(readFile(path.join(mainRoot, "wip-untracked.txt"), "utf8")).resolves.toBe("wip\n");
    // staged still staged (index has staged-v2 for staged.txt)
    const statusAfter = await gitOk(mainRoot, ["status", "--porcelain"]);
    expect(statusAfter).toContain("agent-only.txt");
    expect(statusBefore).toMatch(/staged\.txt/);

    await WorktreeSandbox.remove(session, { force: true });
  });

  it("dirty merge fails closed when main drifts and keeps candidate worktree", async () => {
    const mainRoot = await initGitRepo();
    await writeFile(path.join(mainRoot, "wip.txt"), "launch\n", "utf8");
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-wt-drift-"));
    tempDirs.push(baseDir);
    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "drift1" });
    await writeFile(path.join(session.worktreePath, "agent.txt"), "a\n", "utf8");

    // drift main after session start
    await writeFile(path.join(mainRoot, "drift.txt"), "drift\n", "utf8");

    const gate = new MergeGate(session);
    const result = await gate.merge();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/drifted|fail closed/i);
    }
    // candidate still present
    await expect(readFile(path.join(session.worktreePath, "agent.txt"), "utf8")).resolves.toBe("a\n");
    // main should not have partial agent write
    await expect(readFile(path.join(mainRoot, "agent.txt"), "utf8")).rejects.toThrow();

    await WorktreeSandbox.remove(session, { force: true });
  });
});
