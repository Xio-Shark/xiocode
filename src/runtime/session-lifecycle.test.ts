import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitOk } from "../../extensions/xio-sandbox/src/git.ts";
import { MergeGate } from "../../extensions/xio-sandbox/src/merge-gate.ts";
import { WorktreeSandbox } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";
import { ExtensionHost } from "./extension-host.ts";
import { createPromptRunner, registerRollbackCommand } from "./session-lifecycle.ts";

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
});
