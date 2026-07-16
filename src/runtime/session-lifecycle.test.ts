import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitOk } from "../../extensions/xio-sandbox/src/git.ts";
import { MergeGate } from "../../extensions/xio-sandbox/src/merge-gate.ts";
import { WorktreeSandbox } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";
import { ExtensionHost } from "./extension-host.ts";
import {
  CONTEXT_SUMMARY_NAME,
  ContextCompactionController,
  SessionHistory,
} from "./context-compaction.ts";
import { createPromptRunner, formatRegressCaptureHint, registerRollbackCommand } from "./session-lifecycle.ts";

import type { ChatMessage, LlmClient, ModelInfo } from "./types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createWorktree() {
  const mainRoot = await mkdtemp(path.join(os.tmpdir(), "xio-session-main-"));
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "xio-session-worktrees-"));
  tempDirs.push(mainRoot, baseDir);
  await gitOk(mainRoot, ["init"]);
  await gitOk(mainRoot, ["config", "user.email", "xio@test"]);
  await gitOk(mainRoot, ["config", "user.name", "xio"]);
  await writeFile(path.join(mainRoot, "README.md"), "base\n", "utf8");
  await gitOk(mainRoot, ["add", "README.md"]);
  await gitOk(mainRoot, ["commit", "-m", "init"]);
  return WorktreeSandbox.create({ mainRoot, baseDir, sessionId: "history" });
}

describe("registerRollbackCommand", () => {
  it("fails explicitly without an active worktree sandbox", async () => {
    const host = new ExtensionHost();
    registerRollbackCommand(host, undefined, async () => true);
    await expect(host.runCommand("rollback")).rejects.toThrow(/requires an active git worktree sandbox/i);
  });

  it("restores initial messages and reports the updated session snapshot", async () => {
    const host = new ExtensionHost();
    const requests: ChatMessage[][] = [];
    const snapshots: ChatMessage[][] = [];
    const client: LlmClient = {
      async complete(request) {
        requests.push([...request.messages]);
        return { content: "continued", toolCalls: [] };
      },
    };
    const runPrompt = createPromptRunner({
      host,
      client,
      model: { provider: "test", id: "stub" },
      providerApi: "openai-completions",
      verify: { enabled: false, requireAllPass: true, repairTurns: 3, commands: [] },
      initialMessages: [
        { role: "system", content: "system" },
        { role: "user", content: "saved question" },
        { role: "assistant", content: "saved answer" },
      ],
      onMessagesChanged: (messages) => {
        snapshots.push([...messages]);
      },
    });

    await runPrompt("new question");

    expect(requests[0]!.some((message) => message.content === "saved question")).toBe(true);
    expect(requests[0]!.some((message) => message.content === "new question")).toBe(true);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.some((message) => message.content === "continued")).toBe(true);
  });

  it("invokes onRollbackSuccess after an approved session rollback", async () => {
    const session = await createWorktree();
    const host = new ExtensionHost();
    const events: string[] = [];
    registerRollbackCommand(
      host,
      new MergeGate(session),
      async () => true,
      undefined,
      async ({ kind }) => {
        events.push(kind);
      },
    );
    await writeFile(path.join(session.worktreePath, "broken.ts"), "broken\n", "utf8");
    await expect(host.runCommand("rollback")).resolves.toMatch(/rolled back to session baseline/);
    expect(events).toEqual(["session"]);
    await WorktreeSandbox.remove(session, { force: true });
  });

  it("keeps conversation history available after file rollback", async () => {
    const session = await createWorktree();
    const host = new ExtensionHost();
    registerRollbackCommand(host, new MergeGate(session), async () => true);
    const requests: ChatMessage[][] = [];
    const client: LlmClient = {
      async complete(request) {
        requests.push([...request.messages]);
        return { content: `reply-${requests.length}`, toolCalls: [] };
      },
    };
    const model: ModelInfo = { provider: "test", id: "stub", name: "stub" };
    const runPrompt = createPromptRunner({
      host,
      client,
      model,
      providerApi: "openai-completions",
      verify: { enabled: false, requireAllPass: true, repairTurns: 3, commands: [] },
    });

    await runPrompt("first turn");
    await writeFile(path.join(session.worktreePath, "broken.ts"), "broken\n", "utf8");
    await expect(host.runCommand("rollback")).resolves.toMatch(/rolled back to session baseline/);
    await runPrompt("second turn");

    expect(requests).toHaveLength(2);
    expect(requests[1]!.some((message) => message.content === "first turn")).toBe(true);
    expect(requests[1]!.some((message) => message.content === "second turn")).toBe(true);
    await WorktreeSandbox.remove(session, { force: true });
  });

  it("captures each prompt boundary and keeps chat after turn rollback", async () => {
    const session = await createWorktree();
    const gate = new MergeGate(session);
    const host = new ExtensionHost();
    registerRollbackCommand(host, gate, async () => true);
    const requests: ChatMessage[][] = [];
    const client: LlmClient = {
      async complete(request) {
        requests.push([...request.messages]);
        return { content: `reply-${requests.length}`, toolCalls: [] };
      },
    };
    const runPrompt = createPromptRunner({
      host,
      client,
      model: { provider: "test", id: "stub", name: "stub" },
      providerApi: "openai-completions",
      verify: { enabled: false, requireAllPass: true, repairTurns: 3, commands: [] },
      beforePrompt: () => gate.captureTurnCheckpoint(),
    });

    await writeFile(path.join(session.worktreePath, "prior.txt"), "prior\n", "utf8");
    await runPrompt("turn to undo");
    await writeFile(path.join(session.worktreePath, "prior.txt"), "changed\n", "utf8");
    await expect(host.runCommand("rollback", "turn")).resolves.toMatch(/turn checkpoint/);
    expect(await readFile(path.join(session.worktreePath, "prior.txt"), "utf8")).toBe("prior\n");
    await runPrompt("continue after rollback");

    expect(requests[1]!.some((message) => message.content === "turn to undo")).toBe(true);
    expect(requests[1]!.some((message) => message.content === "continue after rollback")).toBe(true);
    await WorktreeSandbox.remove(session, { force: true });
  });

  it("clears the turn checkpoint after a full session rollback", async () => {
    const session = await createWorktree();
    const gate = new MergeGate(session);
    const host = new ExtensionHost();
    registerRollbackCommand(host, gate, async () => true);
    await writeFile(path.join(session.worktreePath, "prior.txt"), "prior\n", "utf8");
    await gate.captureTurnCheckpoint();
    await writeFile(path.join(session.worktreePath, "later.txt"), "later\n", "utf8");

    await expect(host.runCommand("rollback")).resolves.toMatch(/session baseline/);
    await expect(host.runCommand("rollback", "turn")).rejects.toThrow(/unavailable/i);
    await WorktreeSandbox.remove(session, { force: true });
  });

  it("restores pre-rollback files when checkpoint persistence fails", async () => {
    const session = await createWorktree();
    const gate = new MergeGate(session);
    await writeFile(path.join(session.worktreePath, "prior.txt"), "prior\n", "utf8");
    await gate.captureTurnCheckpoint();
    await writeFile(path.join(session.worktreePath, "later.txt"), "later\n", "utf8");
    gate.setCheckpointClearedHandler(() => {
      throw new Error("snapshot failed");
    });

    await expect(gate.promptRollback(async () => true)).rejects.toThrow(/snapshot failed/i);
    expect(await readFile(path.join(session.worktreePath, "later.txt"), "utf8")).toBe("later\n");
    await WorktreeSandbox.remove(session, { force: true });
  });
});

describe("createPromptRunner context compaction", () => {
  it("automatically compacts through the shared history before the provider request", async () => {
    const host = new ExtensionHost();
    const requests: ChatMessage[][] = [];
    const snapshots: ChatMessage[][] = [];
    const history = new SessionHistory({
      initialMessages: [
        { role: "system", content: "system" },
        { role: "user", content: "old" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "middle" },
        { role: "assistant", content: "middle answer" },
        { role: "user", content: "latest" },
        { role: "assistant", content: "latest answer" },
      ],
      persist: (messages) => {
        snapshots.push([...messages]);
      },
    });
    const client: LlmClient = {
      async complete(request) {
        if (request.messages[0]?.content.includes("compact XioCode")) {
          return {
            content: "summary",
            toolCalls: [],
            usage: { inputTokens: 2, outputTokens: 1, cacheTokens: 0, reasoningTokens: 0 },
          };
        }
        requests.push([...request.messages]);
        return {
          content: "continued",
          toolCalls: [],
          usage: { inputTokens: 3, outputTokens: 1, cacheTokens: 0, reasoningTokens: 0 },
        };
      },
    };
    const controller = new ContextCompactionController({
      history,
      getClient: () => client,
      getModel: () => ({ provider: "test", id: "stub" }),
      maxMessages: 8,
    });
    const runPrompt = createPromptRunner({
      host,
      client,
      model: { provider: "test", id: "stub" },
      providerApi: "openai-completions",
      verify: { enabled: false, requireAllPass: true, repairTurns: 3, commands: [] },
      maxSessionMessages: 8,
      history,
      contextCompaction: controller,
    });

    const result = await runPrompt("next");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.some((message) => message.name === CONTEXT_SUMMARY_NAME)).toBe(true);
    expect(requests[0]!.some((message) => message.content === "latest")).toBe(true);
    expect(requests[0]!.some((message) => message.content === "next")).toBe(true);
    expect(snapshots).toHaveLength(2);
    expect(history.getMessages().some((message) => message.content === "continued")).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2, cacheTokens: 0, reasoningTokens: 0 });
  });

  it("blocks the user provider request when automatic compaction fails", async () => {
    const host = new ExtensionHost();
    const history = new SessionHistory({
      initialMessages: [
        { role: "system", content: "system" },
        { role: "user", content: "old" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "middle" },
        { role: "assistant", content: "middle answer" },
        { role: "user", content: "latest" },
        { role: "assistant", content: "latest answer" },
      ],
    });
    let providerCalls = 0;
    const client: LlmClient = {
      async complete() {
        providerCalls += 1;
        throw new Error("summary unavailable");
      },
    };
    const controller = new ContextCompactionController({
      history,
      getClient: () => client,
      getModel: () => ({ provider: "test", id: "stub" }),
      maxMessages: 8,
    });
    const runPrompt = createPromptRunner({
      host,
      client,
      model: { provider: "test", id: "stub" },
      providerApi: "openai-completions",
      verify: { enabled: false, requireAllPass: true, repairTurns: 3, commands: [] },
      maxSessionMessages: 8,
      history,
      contextCompaction: controller,
    });

    await expect(runPrompt("next")).rejects.toThrow("summary unavailable");
    expect(providerCalls).toBe(1);
    expect(history.getMessages().some((message) => message.content === "next")).toBe(false);
  });
});

describe("formatRegressCaptureHint", () => {
  it("includes run id when known", () => {
    expect(formatRegressCaptureHint()).toBe(
      "hint: capture private regression — /regress  or  xio regress capture --last",
    );
    expect(formatRegressCaptureHint("run-abc")).toBe(
      "hint: capture private regression — /regress  or  xio regress capture --last  (run=run-abc)",
    );
  });
});

describe("createPromptRunner failure nudge", () => {
  it("notifies regress hint when the loop returns success=false", async () => {
    const host = new ExtensionHost();
    const notices: string[] = [];
    let calls = 0;
    const client: LlmClient = {
      async complete() {
        calls += 1;
        return { content: "done", toolCalls: [] };
      },
    };
    const runPrompt = createPromptRunner({
      host,
      client,
      model: { provider: "test", id: "stub" },
      providerApi: "openai-completions",
      verify: {
        enabled: true,
        requireAllPass: true,
        repairTurns: 0,
        commands: [{ name: "fail", argv: ["false"] }],
      },
      doneContract: {
        requireAllPass: true,
        commands: [{ name: "fail", argv: ["false"] }],
      },
      getRunId: () => "run-42",
      sink: {
        notify: (message) => notices.push(message),
      },
    });

    const result = await runPrompt("verify me");
    expect(result.success).toBe(false);
    expect(calls).toBeGreaterThan(0);
    expect(notices.some((n) => n.includes("/regress") && n.includes("run=run-42"))).toBe(true);
    expect(notices.filter((n) => n.startsWith("hint: capture private regression")).length).toBe(1);
  });
});
