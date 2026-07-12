import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "./session-store.ts";
import { CONTEXT_SUMMARY_NAME } from "./context-compaction.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("SessionStore", () => {
  it("saves, lists, loads, updates, and removes a session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    let timestamp = "2026-07-11T00:00:00.000Z";
    const store = new SessionStore({ root, now: () => new Date(timestamp) });
    const input = {
      id: "session1",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp/worktree",
      mainRoot: "/tmp/main",
      messages: [{ role: "user" as const, content: "hello" }],
    };

    const created = await store.save(input);
    timestamp = "2026-07-11T01:00:00.000Z";
    await store.save({ ...input, messages: [...input.messages, { role: "assistant", content: "hi" }] });

    expect((await store.list())[0]?.id).toBe("session1");
    const loaded = await store.load("session1");
    expect(loaded.metadata.schema_version).toBe("xio-session.v2");
    expect(loaded.metadata.schema_version === "xio-session.v2" && loaded.metadata.revision).toBe(2);
    expect(loaded.metadata.created_at).toBe(created.metadata.created_at);
    expect(loaded.metadata.updated_at).toBe(timestamp);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.execution).toEqual({ phase: "idle" });
    expect(JSON.parse(await readFile(path.join(root, "session1", "state.json"), "utf8"))).toMatchObject({
      schema_version: "xio-session.v2",
      revision: 2,
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
    });
    expect((await store.latest("/tmp/main"))?.metadata.id).toBe("session1");
    await store.remove("session1");
    await expect(store.load("session1")).rejects.toThrow(/failed to load session session1/i);
  });

  it("reports corrupt records and rejects path-like ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    await mkdir(path.join(root, "broken"), { recursive: true });
    await writeFile(path.join(root, "broken", "metadata.json"), "not-json", "utf8");
    await writeFile(path.join(root, "broken", "messages.json"), "[]", "utf8");
    const store = new SessionStore({ root });

    await expect(store.load("broken")).rejects.toThrow(/failed to load session broken/i);
    await expect(store.load("../escape")).rejects.toThrow(/invalid session id/i);
    await store.remove("broken");
  });

  it("round-trips the context summary marker without a schema migration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    const store = new SessionStore({ root });
    await store.save({
      id: "compacted",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp/worktree",
      mainRoot: "/tmp/main",
      messages: [
        { role: "system", content: "system" },
        { role: "system", name: CONTEXT_SUMMARY_NAME, content: "[context summary]\nsummary" },
        { role: "user", content: "continue" },
      ],
    });

    const loaded = await store.load("compacted");
    expect(loaded.messages[1]?.name).toBe(CONTEXT_SUMMARY_NAME);
  });

  it("loads legacy v1 records and migrates them on the next save", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    const directory = path.join(root, "legacy");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "metadata.json"), JSON.stringify({
      schema_version: "xio-session.v1",
      id: "legacy",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp/worktree",
      main_root: "/tmp/main",
      worktree_path: "/tmp/worktree",
      created_at: "2026-07-11T00:00:00.000Z",
      updated_at: "2026-07-11T00:00:00.000Z",
    }), "utf8");
    await writeFile(path.join(directory, "messages.json"), JSON.stringify([
      { role: "user", content: "legacy message" },
    ]), "utf8");
    const store = new SessionStore({ root, now: () => new Date("2026-07-12T00:00:00.000Z") });

    const legacy = await store.load("legacy");
    expect(legacy.metadata.schema_version).toBe("xio-session.v1");
    await store.save({
      id: "legacy",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp/worktree",
      mainRoot: "/tmp/main",
      worktreePath: "/tmp/worktree",
      messages: legacy.messages,
      createdAt: legacy.metadata.created_at,
    });

    const migrated = await store.load("legacy");
    expect(migrated.metadata.schema_version).toBe("xio-session.v2");
    expect(migrated.workspace).toMatchObject({
      mode: "worktree",
      lifecycle: "active",
      main_root: "/tmp/main",
      worktree_path: "/tmp/worktree",
      session_id: "legacy",
      epoch: 0,
    });
  });

  it("round-trips explicit workspace and execution checkpoint state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    const store = new SessionStore({ root });
    await store.save({
      id: "checkpointed",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp/worktree",
      mainRoot: "/tmp/main",
      worktreePath: "/tmp/worktree",
      messages: [{ role: "user", content: "continue" }],
      workspace: {
        mode: "worktree",
        lifecycle: "retained",
        main_root: "/tmp/main",
        worktree_path: "/tmp/worktree",
        branch: "xio/checkpointed",
        base_ref: "a".repeat(40),
        repo_id: "repo123",
        session_id: "checkpointed",
        epoch: 1,
      },
      execution: {
        phase: "tool_batch_running",
        turn_id: "turn-1",
        checkpoint: {
          ref: "refs/xiocode/checkpoints/checkpointed/turn-1",
          commit: "b".repeat(40),
          head: "c".repeat(40),
          tree: "d".repeat(40),
        },
        pending_tools: [{ id: "call-1", name: "write", risk: "write" }],
        interrupted_at: "2026-07-12T00:00:00.000Z",
      },
    });

    const loaded = await store.load("checkpointed");
    expect(loaded.workspace?.lifecycle).toBe("retained");
    expect(loaded.execution?.pending_tools).toEqual([{ id: "call-1", name: "write", risk: "write" }]);
  });

  it("allows only one live lease per session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    const first = new SessionStore({ root });
    const second = new SessionStore({ root });
    const release = await first.acquireLease("leased");

    await expect(second.acquireLease("leased")).rejects.toThrow(/already active/i);
    await release();
    const releaseAgain = await second.acquireLease("leased");
    await releaseAgain();
  });
});
