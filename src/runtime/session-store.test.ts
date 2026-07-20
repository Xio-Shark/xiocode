import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "./session-store.ts";
import { CONTEXT_SUMMARY_NAME } from "./context-compaction.ts";
import { JOURNAL_FILE } from "./session-wal.ts";
import { recoverStoredSession } from "./session-recovery.ts";

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

  it("journals mid-turn checkpoints without rewriting full state.json", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    const store = new SessionStore({ root, now: () => new Date("2026-07-15T00:00:00.000Z") });
    const base = {
      id: "wal1",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp/worktree",
      mainRoot: "/tmp/main",
      messages: [{ role: "user" as const, content: "hello" }],
    };
    await store.save(base);
    const statePath = path.join(root, "wal1", "state.json");
    const before = await stat(statePath);
    const beforeText = await readFile(statePath, "utf8");

    const afterTool = [
      ...base.messages,
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [{ id: "c1", name: "read", arguments: { path: "a.ts" } }],
      },
    ];
    await store.save({
      ...base,
      messages: afterTool,
      execution: {
        phase: "tool_batch_running",
        turn_id: "t1",
        pending_tools: [{ id: "c1", name: "read" }],
      },
      durability: "journal",
    });

    const afterJournal = await stat(statePath);
    expect(afterJournal.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(statePath, "utf8")).toBe(beforeText);
    const journalText = await readFile(path.join(root, "wal1", JOURNAL_FILE), "utf8");
    expect(journalText.length).toBeLessThan(beforeText.length);
    expect(journalText).toContain("append_messages");
    expect(journalText).toContain("tool_batch_running");

    const loaded = await store.load("wal1");
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.execution?.phase).toBe("tool_batch_running");
    expect(loaded.execution?.pending_tools).toEqual([{ id: "c1", name: "read" }]);
  });

  it("snapshots on turn complete and truncates the journal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    const store = new SessionStore({ root });
    const base = {
      id: "wal2",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp/worktree",
      mainRoot: "/tmp/main",
      messages: [{ role: "user" as const, content: "hello" }],
    };
    await store.save(base);
    await store.save({
      ...base,
      messages: [...base.messages, { role: "assistant", content: "hi" }],
      execution: { phase: "awaiting_provider", turn_id: "t1" },
      durability: "journal",
    });
    expect((await readFile(path.join(root, "wal2", JOURNAL_FILE), "utf8")).trim().length).toBeGreaterThan(0);

    await store.save({
      ...base,
      messages: [
        ...base.messages,
        { role: "assistant", content: "hi" },
        { role: "user", content: "next" },
      ],
      execution: { phase: "idle" },
      durability: "snapshot",
    });

    const journalAfter = await readFile(path.join(root, "wal2", JOURNAL_FILE), "utf8");
    expect(journalAfter.trim()).toBe("");
    const state = JSON.parse(await readFile(path.join(root, "wal2", "state.json"), "utf8")) as {
      messages: unknown[];
      revision: number;
    };
    expect(state.messages).toHaveLength(3);
    expect(state.revision).toBe(2);
    const loaded = await store.load("wal2");
    expect(loaded.messages).toHaveLength(3);
    expect(loaded.execution?.phase).toBe("idle");
  });

  it("replays crash phases for recovery without re-executing tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    const store = new SessionStore({ root });
    const base = {
      id: "crash",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp/worktree",
      mainRoot: "/tmp/main",
      worktreePath: "/tmp/worktree",
      messages: [{ role: "user" as const, content: "do work" }],
      workspace: {
        mode: "worktree" as const,
        lifecycle: "active" as const,
        main_root: "/tmp/main",
        worktree_path: "/tmp/worktree",
        branch: "xio/crash",
        base_ref: "a".repeat(40),
        repo_id: "repo",
        session_id: "crash",
        epoch: 0,
      },
    };

    // awaiting_provider
    await store.save({
      ...base,
      execution: { phase: "awaiting_provider", turn_id: "t1" },
    });
    let recovered = recoverStoredSession(await store.load("crash"));
    expect(recovered?.execution?.phase).toBe("idle");
    expect(recovered?.interruptedTools).toBe(0);

    // partial parallel tool batch
    const withTools = [
      ...base.messages,
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [
          { id: "r1", name: "read", arguments: { path: "a" } },
          { id: "r2", name: "read", arguments: { path: "b" } },
        ],
      },
      { role: "tool" as const, toolCallId: "r1", name: "read", content: "a-body" },
    ];
    await store.save({
      ...base,
      messages: withTools,
      execution: {
        phase: "tool_batch_running",
        turn_id: "t1",
        pending_tools: [{ id: "r2", name: "read" }],
      },
      durability: "journal",
    });
    // Fresh store instance simulates process crash + restart.
    const reloaded = new SessionStore({ root });
    recovered = recoverStoredSession(await reloaded.load("crash"));
    expect(recovered?.interruptedTools).toBe(1);
    expect(recovered?.messages.some((m) =>
      m.role === "tool" && m.toolCallId === "r2" && String(m.content).includes("completion unknown")
    )).toBe(true);

    // completed batch (no pending)
    await reloaded.save({
      ...base,
      messages: [
        ...withTools,
        { role: "tool", toolCallId: "r2", name: "read", content: "b-body" },
      ],
      execution: { phase: "tool_batch_running", turn_id: "t1" },
      durability: "journal",
    });
    recovered = recoverStoredSession(await reloaded.load("crash"));
    expect(recovered?.interruptedTools).toBe(0);

    // turn completion snapshot
    await reloaded.save({
      ...base,
      messages: [
        ...withTools,
        { role: "tool", toolCallId: "r2", name: "read", content: "b-body" },
        { role: "assistant", content: "done" },
      ],
      execution: { phase: "idle" },
      durability: "snapshot",
    });
    recovered = recoverStoredSession(await reloaded.load("crash"));
    expect(recovered?.execution?.phase).toBe("idle");
    expect(recovered?.messages.filter((m) => m.role === "assistant").at(-1)?.content).toBe("done");

    // workspace finalization
    await reloaded.save({
      ...base,
      messages: recovered!.messages.filter((m) => m.name !== "xiocode_session_recovery"),
      workspace: { ...base.workspace, lifecycle: "merged" },
      execution: { phase: "idle" },
      durability: "snapshot",
    });
    const finalized = await reloaded.load("crash");
    expect(finalized.workspace?.lifecycle).toBe("merged");
  });

  it("fails closed on corrupt journal without dropping to empty state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    const store = new SessionStore({ root });
    await store.save({
      id: "badj",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp",
      mainRoot: "/tmp",
      messages: [{ role: "user", content: "x" }],
    });
    await writeFile(path.join(root, "badj", JOURNAL_FILE), "{not-json\n", "utf8");
    await expect(store.load("badj")).rejects.toThrow(/corrupt session journal|failed to load session badj/i);
  });

  it("keeps legacy v2 without journal readable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    const store = new SessionStore({ root });
    await store.save({
      id: "legacyv2",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp",
      mainRoot: "/tmp",
      messages: [{ role: "user", content: "only-snapshot" }],
    });
    await rm(path.join(root, "legacyv2", JOURNAL_FILE), { force: true });
    const loaded = await store.load("legacyv2");
    expect(loaded.messages[0]?.content).toBe("only-snapshot");
  });

  it("journal hot path is O(delta): successive appends stay under 20ms P95 with large history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    const store = new SessionStore({ root });
    const historySize = 400;
    let messages: Array<{ role: "user" | "assistant"; content: string }> = Array.from(
      { length: historySize },
      (_, index) => ({ role: "user" as const, content: `hist-${index}-${"x".repeat(64)}` }),
    );
    const base = {
      id: "hotpath",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp/worktree",
      mainRoot: "/tmp/main",
    };
    await store.save({ ...base, messages, durability: "snapshot" });
    const statePath = path.join(root, "hotpath", "state.json");
    const before = await stat(statePath);

    const samples: number[] = [];
    const iterations = 40;
    for (let index = 0; index < iterations; index += 1) {
      messages = [
        ...messages,
        {
          role: "assistant",
          content: `tool-result-${index}`,
          // keep shape close to tool-heavy path
        },
      ];
      const started = performance.now();
      await store.save({
        ...base,
        messages,
        execution: {
          phase: "tool_batch_running",
          turn_id: "t-hot",
          pending_tools: [{ id: `c${index}`, name: "read" }],
        },
        durability: "journal",
      });
      samples.push(performance.now() - started);
    }

    const after = await stat(statePath);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    samples.sort((left, right) => left - right);
    const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]!;
    expect(p95).toBeLessThan(20);

    // Cold reload still materializes full history + journal.
    const reloaded = new SessionStore({ root });
    const loaded = await reloaded.load("hotpath");
    expect(loaded.messages).toHaveLength(historySize + iterations);
    expect(loaded.execution?.phase).toBe("tool_batch_running");
  });

  it("cold journal path still detects non-append rewrite and snapshots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    const writer = new SessionStore({ root });
    await writer.save({
      id: "rewrite",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp",
      mainRoot: "/tmp",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
    });
    // Fresh process: no live cursor — content prefix check applies.
    const cold = new SessionStore({ root });
    await cold.save({
      id: "rewrite",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp",
      mainRoot: "/tmp",
      messages: [
        { role: "user", content: "changed" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      durability: "journal",
    });
    const state = JSON.parse(await readFile(path.join(root, "rewrite", "state.json"), "utf8")) as {
      messages: Array<{ content: string }>;
      revision: number;
    };
    // Non-append forced a snapshot rewrite (journal would leave wrong prefix).
    expect(state.messages[0]?.content).toBe("changed");
    expect(state.revision).toBe(2);
    const journal = await readFile(path.join(root, "rewrite", JOURNAL_FILE), "utf8");
    expect(journal.trim()).toBe("");
  });

  it("persists durable compaction facts that survive kill+resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    const store = new SessionStore({ root, now: () => new Date("2026-07-20T00:00:00.000Z") });
    await store.save({
      id: "fact1",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp",
      mainRoot: "/tmp",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "old" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "continue" },
      ],
    });

    const compacted = [
      { role: "system" as const, content: "system" },
      {
        role: "system" as const,
        name: CONTEXT_SUMMARY_NAME,
        content: "[context summary]\nGoal: continue",
      },
      { role: "user" as const, content: "continue" },
    ];
    await store.save({
      id: "fact1",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp",
      mainRoot: "/tmp",
      messages: compacted,
      compaction: {
        summary: "Goal: continue",
        beforeMessages: 4,
        afterMessages: 3,
        beforeTokens: 40,
        afterTokens: 20,
        firstRetainedIndex: 3,
      },
    });

    const state = JSON.parse(await readFile(path.join(root, "fact1", "state.json"), "utf8")) as {
      compaction_log?: Array<{ summary: string; before_messages: number }>;
      messages: Array<{ name?: string; content: string }>;
    };
    expect(state.compaction_log?.[0]?.summary).toBe("Goal: continue");
    expect(state.compaction_log?.[0]?.before_messages).toBe(4);
    expect(state.messages.some((message) => message.name === CONTEXT_SUMMARY_NAME)).toBe(true);

    // Simulate process death: fresh store must rebuild projection + facts.
    const reloaded = new SessionStore({ root });
    const loaded = await reloaded.load("fact1");
    expect(loaded.compactionLog?.[0]?.summary).toBe("Goal: continue");
    expect(loaded.messages.some((message) => message.name === CONTEXT_SUMMARY_NAME)).toBe(true);
    expect(loaded.messages.some((message) => message.content === "old")).toBe(false);
  });

  it("rebuilds compacted projection from journal when snapshot never landed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    const store = new SessionStore({ root, now: () => new Date("2026-07-20T01:00:00.000Z") });
    await store.save({
      id: "crash-compact",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp",
      mainRoot: "/tmp",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "old work" },
        { role: "assistant", content: "done old" },
        { role: "user", content: "keep me" },
      ],
    });

    // Manually append a compaction WAL record as if crash occurred after journal
    // append and before state.json rewrite / truncate.
    const { appendJournal } = await import("./session-wal.ts");
    const projected = [
      { role: "system" as const, content: "system" },
      {
        role: "system" as const,
        name: CONTEXT_SUMMARY_NAME,
        content: "[context summary]\ncrash-safe summary",
      },
      { role: "user" as const, content: "keep me" },
    ];
    await appendJournal({
      directory: path.join(root, "crash-compact"),
      nextSeq: 1,
      now: () => new Date("2026-07-20T01:00:01.000Z"),
      compaction: {
        fact: {
          summary: "crash-safe summary",
          before_messages: 4,
          after_messages: 3,
          before_tokens: 50,
          after_tokens: 25,
          first_retained_index: 3,
        },
        messages: projected,
      },
    });

    const reloaded = new SessionStore({ root });
    const loaded = await reloaded.load("crash-compact");
    expect(loaded.messages).toEqual(projected);
    expect(loaded.compactionLog?.[0]?.summary).toBe("crash-safe summary");
  });

  it("ignores unknown journal op kinds for forward compatibility", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    const store = new SessionStore({ root, now: () => new Date("2026-07-20T02:00:00.000Z") });
    await store.save({
      id: "fwd",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp",
      mainRoot: "/tmp",
      messages: [{ role: "user", content: "hello" }],
    });
    await store.save({
      id: "fwd",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp",
      mainRoot: "/tmp",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      execution: { phase: "awaiting_provider", turn_id: "t1" },
      durability: "journal",
    });

    // Inject a future op between known records by rewriting journal.
    const journalPath = path.join(root, "fwd", JOURNAL_FILE);
    const existing = (await readFile(journalPath, "utf8")).trimEnd();
    const future = JSON.stringify({
      schema_version: "xio-session-wal.v1",
      seq: 3,
      t: "2026-07-20T02:00:01.000Z",
      op: "future_branch_label",
      label: "experimental",
    });
    await writeFile(journalPath, `${existing}\n${future}\n`, "utf8");

    const reloaded = new SessionStore({ root });
    const loaded = await reloaded.load("fwd");
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.execution?.phase).toBe("awaiting_provider");
  });
});
