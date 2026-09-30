import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DirectRollbackGate } from "../../extensions/xio-sandbox/src/direct-gate.ts";
import { gitOk } from "../../extensions/xio-sandbox/src/git.ts";
import { SessionHistory } from "./context-compaction.ts";
import { KernelSession } from "./process/kernel-session.ts";
import { formatRewindPoints, RewindLedger, rewindSnapshotIds } from "./rewind.ts";
import type { ChatMessage } from "./types.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function repo(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "xio-rewind-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await gitOk(root, ["init"]);
  await gitOk(root, ["config", "user.email", "xio@test"]);
  await gitOk(root, ["config", "user.name", "xio"]);
  await writeFile(path.join(root, "app.txt"), "v0\n", "utf8");
  await gitOk(root, ["add", "app.txt"]);
  await gitOk(root, ["commit", "-m", "init"]);
  return root;
}

async function kernelFor(root: string, domainPath?: string): Promise<KernelSession> {
  const domain = domainPath ?? await mkdtemp(path.join(os.tmpdir(), "xio-rewind-domain-"));
  const session = await KernelSession.open({ sessionId: "rewind", workspaceRoot: root, domainPath: domain });
  cleanups.push(async () => {
    session.close();
    if (!domainPath) await rm(domain, { recursive: true, force: true });
  });
  return session;
}

type Rig = Readonly<{
  root: string;
  kernel: KernelSession;
  gate: DirectRollbackGate;
  history: SessionHistory;
  ledger: RewindLedger;
  asked: string[];
  /** One product turn: checkpoint, point, the agent's file write and messages. */
  turn: (prompt: string, fileContent: string) => Promise<void>;
}>;

async function rig(options: Readonly<{ approve?: boolean; busy?: () => boolean }> = {}): Promise<Rig> {
  const root = await repo();
  const kernel = await kernelFor(root);
  const gate = new DirectRollbackGate(kernel);
  await gate.initSessionBaseline();
  const history = new SessionHistory();
  const asked: string[] = [];
  const ledger = new RewindLedger({
    history,
    gate,
    journal: kernel,
    ask: async (question) => {
      asked.push(question);
      return options.approve !== false;
    },
    ...(options.busy ? { isBusy: options.busy } : {}),
  });
  const turn = async (prompt: string, fileContent: string): Promise<void> => {
    const checkpoint = await gate.captureTurnCheckpoint();
    ledger.record({ messageCount: history.length, prompt, snapshotId: checkpoint.snapshot_id });
    const system: ChatMessage[] = history.length === 0 ? [{ role: "system", content: "sys" }] : [];
    await history.replace([
      ...history.getMessages(),
      ...system,
      { role: "user", content: prompt },
      { role: "assistant", content: `did: ${prompt}` },
    ]);
    await writeFile(path.join(root, "app.txt"), fileContent, "utf8");
  };
  return { root, kernel, gate, history, ledger, asked, turn };
}

const read = (root: string) => readFile(path.join(root, "app.txt"), "utf8");

describe("RewindLedger", () => {
  it("rewinds files and conversation to the start of a turn and hands the prompt back", async () => {
    const r = await rig();
    await r.turn("add feature A", "v1\n");
    await r.turn("refactor A\nwith details", "v2\n");
    await r.turn("break everything", "v3\n");

    const points = r.ledger.list();
    expect(points.map((p) => p.prompt)).toEqual(["add feature A", "refactor A", "break everything"]);
    expect(points.every((p) => p.code.available && p.conversation.available)).toBe(true);

    const outcome = await r.ledger.rewind(2, "both");
    expect(outcome.skipped).toBe(false);
    expect(outcome.prompt).toBe("refactor A\nwith details");
    expect(outcome.summary).toContain("verified the files by fingerprint");
    await expect(read(r.root)).resolves.toBe("v1\n");
    expect(r.history.getMessages().map((m) => m.content)).toEqual(["sys", "add feature A", "did: add feature A"]);
    // Turns 2 and 3 no longer happened.
    expect(r.ledger.list().map((p) => p.index)).toEqual([1]);
    expect(r.asked).toHaveLength(1);
  });

  it("rewinds only the conversation, or only the files", async () => {
    const r = await rig();
    await r.turn("one", "v1\n");
    await r.turn("two", "v2\n");

    await r.ledger.rewind(2, "code");
    await expect(read(r.root)).resolves.toBe("v1\n");
    expect(r.history.length).toBe(5); // conversation untouched
    expect(r.ledger.list()).toHaveLength(2);

    await writeFile(path.join(r.root, "app.txt"), "edited\n", "utf8");
    const conversation = await r.ledger.rewind(2, "conversation");
    expect(conversation.prompt).toBe("two");
    await expect(read(r.root)).resolves.toBe("edited\n"); // files untouched
    expect(r.history.getMessages().map((m) => m.content)).toEqual(["sys", "one", "did: one"]);
    expect(r.ledger.list()).toHaveLength(1);
  });

  it("changes nothing when the file restore is declined", async () => {
    const r = await rig({ approve: false });
    await r.turn("one", "v1\n");
    await r.turn("two", "v2\n");
    const outcome = await r.ledger.rewind(1, "both");
    expect(outcome.skipped).toBe(true);
    await expect(read(r.root)).resolves.toBe("v2\n");
    expect(r.history.length).toBe(5);
    expect(r.ledger.list()).toHaveLength(2);
  });

  it("says why a point cannot restore the conversation after compaction", async () => {
    const r = await rig();
    await r.turn("one", "v1\n");
    await r.turn("two", "v2\n");
    await r.history.replace([{ role: "system", content: "sys" }, { role: "user", content: "summary of earlier work" }]);

    const [first] = r.ledger.list();
    expect(first?.conversation).toEqual({ available: false, reason: "the conversation was compacted after this turn" });
    expect(first?.code.available).toBe(true);
    await expect(r.ledger.rewind(1, "both")).rejects.toThrow(/compacted/);
    await expect(read(r.root)).resolves.toBe("v2\n"); // a refused rewind restores nothing
  });

  it("refuses while a turn is running", async () => {
    const r = await rig({ busy: () => true });
    await r.turn("one", "v1\n");
    await expect(r.ledger.rewind(1, "both")).rejects.toThrow(/while a turn is running/);
  });

  it("offers conversation rewind without a file gate and says why files cannot be restored", async () => {
    const history = new SessionHistory();
    const ledger = new RewindLedger({ history, ask: async () => true });
    ledger.record({ messageCount: 0, prompt: "hello" });
    await history.replace([{ role: "system", content: "sys" }, { role: "user", content: "hello" }]);
    const [point] = ledger.list();
    expect(point?.code).toEqual({ available: false, reason: "file rewind needs direct mode in a git repository" });
    await expect(ledger.rewind(1, "code")).rejects.toThrow(/direct mode/);
    expect((await ledger.rewind(1, "conversation")).prompt).toBe("hello");
    expect(history.length).toBe(0);
  });

  it("survives a restart through the kernel journal and keeps those snapshots alive", async () => {
    const root = await repo();
    const domain = await mkdtemp(path.join(os.tmpdir(), "xio-rewind-domain-"));
    cleanups.push(() => rm(domain, { recursive: true, force: true }));
    const messages: ChatMessage[] = [];
    {
      const kernel = await kernelFor(root, domain);
      const gate = new DirectRollbackGate(kernel);
      await gate.initSessionBaseline();
      const history = new SessionHistory();
      const ledger = new RewindLedger({ history, gate, journal: kernel, ask: async () => true });
      for (const [prompt, content] of [["one", "v1\n"], ["two", "v2\n"], ["three", "v3\n"]] as const) {
        const checkpoint = await gate.captureTurnCheckpoint();
        ledger.record({ messageCount: history.length, prompt, snapshotId: checkpoint.snapshot_id });
        await history.replace([...history.getMessages(), { role: "user", content: prompt }]);
        await writeFile(path.join(root, "app.txt"), content, "utf8");
      }
      await ledger.rewind(3, "conversation"); // journaled: turn 3 no longer happened
      messages.push(...history.getMessages());
      kernel.close();
    }

    const kernel = await kernelFor(root, domain);
    expect(rewindSnapshotIds(kernel)).toHaveLength(2);
    const gate = new DirectRollbackGate(kernel);
    await gate.initSessionBaseline(rewindSnapshotIds(kernel));
    const ledger = new RewindLedger({
      history: new SessionHistory({ initialMessages: messages }),
      gate,
      journal: kernel,
      ask: async () => true,
    });
    expect(ledger.list().map((p) => [p.prompt, p.code.available])).toEqual([["one", true], ["two", true]]);
    await ledger.rewind(1, "code");
    await expect(read(root)).resolves.toBe("v0\n");
  });

  it("formats the list with what each point can restore", () => {
    expect(formatRewindPoints([])).toMatch(/Nothing to rewind to yet/);
    const text = formatRewindPoints([{
      index: 1,
      at: "",
      prompt: "fix tests",
      code: { available: false, reason: "x" },
      conversation: { available: true },
    }]);
    expect(text).toContain("1. fix tests  [conversation]");
  });
});
