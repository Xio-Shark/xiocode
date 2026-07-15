import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitOk } from "../../extensions/xio-sandbox/src/git.ts";
import { WorktreeSandbox } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";
import { SessionStore } from "../runtime/session-store.ts";
import { deleteStoredSession } from "./run-agent-cli.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function initGitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-del-main-"));
  tempDirs.push(root);
  await gitOk(root, ["init"]);
  await gitOk(root, ["config", "user.email", "xio@test"]);
  await gitOk(root, ["config", "user.name", "xio"]);
  await writeFile(path.join(root, "README.md"), "base\n", "utf8");
  await gitOk(root, ["add", "README.md"]);
  await gitOk(root, ["commit", "-m", "init"]);
  return root;
}

describe("deleteStoredSession", () => {
  it("removes worktree, branch, checkpoint refs, and session directory for active sessions", async () => {
    const mainRoot = await initGitRepo();
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-del-wt-"));
    const sessionsRoot = await mkdtemp(path.join(os.tmpdir(), "xio-del-sess-"));
    tempDirs.push(baseDir, sessionsRoot);

    const session = await WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "delactive1" });
    await writeFile(path.join(session.worktreePath, "wip.txt"), "x\n", "utf8");
    const checkpoint = await WorktreeSandbox.captureDurableCheckpoint(session, "turn1");
    expect(await gitOk(mainRoot, ["rev-parse", checkpoint.ref])).toBe(checkpoint.commit);

    const store = new SessionStore({ root: sessionsRoot });
    await store.save({
      id: "delactive1",
      model: { provider: "test", id: "m" },
      cwd: session.worktreePath,
      mainRoot,
      worktreePath: session.worktreePath,
      messages: [{ role: "user", content: "hi" }],
      workspace: {
        mode: "worktree",
        lifecycle: "active",
        main_root: mainRoot,
        worktree_path: session.worktreePath,
        branch: session.branch,
        base_ref: session.baseRef,
        baseline_tree: session.baselineTree,
        repo_id: session.repoId,
        session_id: session.sessionId,
        epoch: 0,
      },
      execution: {
        phase: "idle",
        checkpoint: {
          ref: checkpoint.ref,
          commit: checkpoint.commit,
          head: checkpoint.head,
          tree: checkpoint.tree,
        },
      },
    });

    await deleteStoredSession(store, "delactive1");

    await expect(store.load("delactive1")).rejects.toThrow();
    await expect(readFile(path.join(session.worktreePath, "wip.txt"), "utf8")).rejects.toThrow();
    const worktrees = await gitOk(mainRoot, ["worktree", "list", "--porcelain"]);
    expect(worktrees).not.toContain(session.worktreePath);
    await expect(gitOk(mainRoot, ["rev-parse", "--verify", session.branch])).rejects.toThrow();
    await expect(gitOk(mainRoot, ["rev-parse", "--verify", checkpoint.ref])).rejects.toThrow();
  });

  it("fails closed on identity mismatch without deleting metadata", async () => {
    const mainRoot = await initGitRepo();
    const sessionsRoot = await mkdtemp(path.join(os.tmpdir(), "xio-del-mismatch-"));
    tempDirs.push(sessionsRoot);
    const store = new SessionStore({ root: sessionsRoot });
    await store.save({
      id: "badid",
      model: { provider: "test", id: "m" },
      cwd: mainRoot,
      mainRoot,
      messages: [],
      workspace: {
        mode: "worktree",
        lifecycle: "active",
        main_root: mainRoot,
        worktree_path: path.join(mainRoot, "no-such-worktree"),
        branch: "xio/badid",
        base_ref: await gitOk(mainRoot, ["rev-parse", "HEAD"]),
        repo_id: WorktreeSandbox.repoId(mainRoot),
        session_id: "badid",
        epoch: 0,
      },
    });

    await expect(deleteStoredSession(store, "badid")).rejects.toThrow();
    const stillThere = await store.load("badid");
    expect(stillThere.metadata.id).toBe("badid");
  });
});
