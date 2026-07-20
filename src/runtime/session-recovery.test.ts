import { describe, expect, it } from "vitest";

import { recoverStoredSession, toWorktreeSession } from "./session-recovery.ts";

import type { StoredSession } from "./session-store.ts";

function interruptedSession(): StoredSession {
  const now = "2026-07-12T00:00:00.000Z";
  const workspace = {
    mode: "worktree" as const,
    lifecycle: "active" as const,
    main_root: "/tmp/main",
    worktree_path: "/tmp/worktrees/repo/session",
    branch: "xio/session",
    base_ref: "abc123",
    repo_id: "repo",
    session_id: "session",
    epoch: 0,
  };
  const execution = {
    phase: "tool_batch_running" as const,
    pending_tools: [{ id: "call-1", name: "bash" }],
  };
  return {
    metadata: {
      schema_version: "xio-session.v2",
      revision: 1,
      id: "session",
      model: { provider: "test", id: "model" },
      cwd: workspace.worktree_path,
      main_root: workspace.main_root,
      worktree_path: workspace.worktree_path,
      created_at: now,
      updated_at: now,
      workspace,
      execution,
    },
    workspace,
    execution,
    messages: [
      { role: "user", content: "change file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "bash", arguments: { command: "write" } }],
      },
    ],
  };
}

describe("session recovery", () => {
  it("repairs orphan tool calls without replaying them", () => {
    const recovered = recoverStoredSession(interruptedSession(), new Date("2026-07-12T01:00:00.000Z"));
    expect(recovered?.interruptedTools).toBe(1);
    expect(recovered?.execution).toMatchObject({ phase: "idle", interrupted_at: "2026-07-12T01:00:00.000Z" });
    expect(recovered?.messages.find((message) => message.toolCallId === "call-1")?.content)
      .toMatch(/completion unknown/i);
    expect(recovered?.messages.some((message) => message.name === "xiocode_session_recovery")).toBe(true);
  });

  it("requires complete worktree identity", () => {
    const stored = interruptedSession();
    expect(toWorktreeSession(stored.workspace)).toMatchObject({ branch: "xio/session" });
    expect(() => toWorktreeSession({ ...stored.workspace!, branch: undefined })).toThrow(/missing branch/i);
  });

  it("keeps finalized sessions chat-resumable without claiming file recovery", () => {
    const stored = interruptedSession();
    const recovered = recoverStoredSession({
      ...stored,
      workspace: { ...stored.workspace!, lifecycle: "clean_removed" },
      execution: { phase: "idle" },
    });

    expect(recovered?.filesRecoverable).toBe(false);
    expect(recovered?.messages.at(-1)?.content).toMatch(/recovered chat only/i);
  });

  it("labels v1 sessions as legacy chat-only recovery", () => {
    const recovered = recoverStoredSession({
      metadata: {
        schema_version: "xio-session.v1",
        id: "legacy",
        model: { provider: "test", id: "model" },
        cwd: "/tmp/old-worktree",
        main_root: "/tmp/main",
        worktree_path: "/tmp/old-worktree",
        created_at: "2026-07-12T00:00:00.000Z",
        updated_at: "2026-07-12T00:00:00.000Z",
      },
      messages: [{ role: "user", content: "legacy" }],
    });

    expect(recovered?.filesRecoverable).toBe(false);
    expect(recovered?.messages.at(-1)?.content).toMatch(/legacy chat only/i);
  });

  it("repairs compacted interrupted sessions without re-dispatching tools", () => {
    const stored: StoredSession = {
      metadata: {
        schema_version: "xio-session.v2",
        revision: 2,
        id: "compacted-resume",
        model: { provider: "test", id: "model" },
        cwd: "/tmp/worktree",
        main_root: "/tmp/main",
        worktree_path: "/tmp/worktree",
        created_at: "2026-07-20T00:00:00.000Z",
        updated_at: "2026-07-20T00:00:00.000Z",
        workspace: {
          mode: "worktree",
          lifecycle: "active",
          main_root: "/tmp/main",
          worktree_path: "/tmp/worktree",
          branch: "xio/compacted",
          base_ref: "abc",
          repo_id: "repo",
          session_id: "compacted-resume",
          epoch: 0,
        },
        execution: {
          phase: "tool_batch_running",
          pending_tools: [{ id: "call-9", name: "bash" }],
        },
      },
      workspace: {
        mode: "worktree",
        lifecycle: "active",
        main_root: "/tmp/main",
        worktree_path: "/tmp/worktree",
        branch: "xio/compacted",
        base_ref: "abc",
        repo_id: "repo",
        session_id: "compacted-resume",
        epoch: 0,
      },
      execution: {
        phase: "tool_batch_running",
        pending_tools: [{ id: "call-9", name: "bash" }],
      },
      compactionLog: [{
        summary: "Prior turns compacted",
        before_messages: 20,
        after_messages: 4,
        before_tokens: 8000,
        after_tokens: 400,
        first_retained_index: 16,
        t: "2026-07-20T00:00:00.000Z",
      }],
      messages: [
        { role: "system", content: "system" },
        {
          role: "system",
          name: "xiocode_context_summary",
          content: "[context summary]\nPrior turns compacted",
        },
        { role: "user", content: "finish the edit" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-9", name: "bash", arguments: { command: "true" } }],
        },
      ],
    };

    // Recovery is pure message projection repair — no tool executor is involved.
    const recovered = recoverStoredSession(stored, new Date("2026-07-20T01:00:00.000Z"));
    expect(recovered?.interruptedTools).toBe(1);
    expect(recovered?.messages.some((message) =>
      message.role === "tool" && message.toolCallId === "call-9"
      && String(message.content).includes("completion unknown")
    )).toBe(true);
    expect(recovered?.messages.some((message) => message.name === "xiocode_context_summary")).toBe(true);
    // Historical tool call remains a message fact; it is not executed.
    expect(recovered?.messages.some((message) =>
      message.role === "assistant"
      && message.toolCalls?.some((call) => call.id === "call-9")
    )).toBe(true);
  });
});
