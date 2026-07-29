import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WAL_SCHEMA,
  appendJournal,
  applyJournal,
  encodeWalRecords,
  journalPath,
  readJournal,
  truncateJournal,
  writeJsonAtomicDurable,
  type WalExecution,
  type WalWorkspace,
} from "./session-wal.ts";
import type { ChatMessage } from "./types.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-wal-"));
  roots.push(root);
  return root;
}

const NOW = () => new Date("2026-07-26T00:00:00.000Z");

const EXECUTION: WalExecution = { phase: "turn_started", turn_id: "turn-1" };

const WORKSPACE: WalWorkspace = {
  mode: "main",
  lifecycle: "active",
  main_root: "/tmp/main",
  epoch: 0,
};

function userMessage(content: string): ChatMessage {
  return { role: "user", content };
}

describe("encodeWalRecords", () => {
  it("encodes ops in a fixed order with contiguous seqs from nextSeq", () => {
    const records = encodeWalRecords({
      directory: "/unused",
      nextSeq: 5,
      now: NOW,
      execution: EXECUTION,
      appendMessages: [userMessage("a")],
      setMessages: [userMessage("b")],
      model: { provider: "test", id: "model-a" },
      workspace: WORKSPACE,
    });

    expect(records.map((record) => record.op)).toEqual([
      "execution",
      "append_messages",
      "set_messages",
      "set_model",
      "set_workspace",
    ]);
    expect(records.map((record) => record.seq)).toEqual([5, 6, 7, 8, 9]);
    expect(records.every((record) => record.schema_version === WAL_SCHEMA)).toBe(true);
    expect(records.every((record) => record.t === NOW().toISOString())).toBe(true);
  });

  it("prefers the compaction op over bare set_messages and stamps the fact time", () => {
    const records = encodeWalRecords({
      directory: "/unused",
      nextSeq: 1,
      now: NOW,
      setMessages: [userMessage("ignored")],
      compaction: {
        fact: {
          summary: "squashed",
          before_messages: 10,
          after_messages: 2,
          before_tokens: 1000,
          after_tokens: 100,
          first_retained_index: 8,
        },
        messages: [userMessage("kept")],
      },
    });

    expect(records.map((record) => record.op)).toEqual(["compaction"]);
    expect(records[0]?.compaction?.t).toBe(NOW().toISOString());
    expect(records[0]?.messages).toEqual([userMessage("kept")]);
  });
});

describe("appendJournal / readJournal", () => {
  it("round-trips appended batches and keeps seq contiguous across calls", async () => {
    const directory = await tempDir();

    const afterFirst = await appendJournal({
      directory,
      nextSeq: 1,
      now: NOW,
      execution: EXECUTION,
      appendMessages: [userMessage("hello")],
    });
    expect(afterFirst).toBe(3);

    const afterSecond = await appendJournal({
      directory,
      nextSeq: afterFirst,
      now: NOW,
      model: { provider: "test", id: "model-a" },
    });
    expect(afterSecond).toBe(4);

    const { records, nextSeq } = await readJournal(directory);
    expect(nextSeq).toBe(4);
    expect(records.map((record) => [record.seq, record.op])).toEqual([
      [1, "execution"],
      [2, "append_messages"],
      [3, "set_model"],
    ]);
  });

  it("appends nothing for an empty input and returns nextSeq unchanged", async () => {
    const directory = await tempDir();

    expect(await appendJournal({ directory, nextSeq: 7, now: NOW })).toBe(7);
    await expect(readFile(journalPath(directory), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns an empty journal for a missing or blank file", async () => {
    const directory = await tempDir();
    expect(await readJournal(directory)).toEqual({ records: [], nextSeq: 1, warnings: [] });

    await writeFile(journalPath(directory), "\n\n", "utf8");
    expect(await readJournal(directory)).toEqual({ records: [], nextSeq: 1, warnings: [] });
  });

  it("drops a torn newline-less tail and heals the file for the next append", async () => {
    const directory = await tempDir();
    await appendJournal({ directory, nextSeq: 1, now: NOW, appendMessages: [userMessage("a")] });
    const intact = await readFile(journalPath(directory), "utf8");
    // Crash mid-append: half a JSON record, no trailing newline.
    await writeFile(journalPath(directory), `${intact}{"schema_version":"${WAL_SCHEMA}","seq":2,"t":"20`, "utf8");

    const first = await readJournal(directory);
    expect(first.records.map((record) => record.seq)).toEqual([1]);
    expect(first.nextSeq).toBe(2);
    expect(first.warnings).toEqual([
      "session journal: dropped torn tail record (crash mid-append)",
    ]);
    // File healed: the torn bytes are gone and a follow-up append round-trips.
    expect(await readFile(journalPath(directory), "utf8")).toBe(intact);
    await appendJournal({ directory, nextSeq: first.nextSeq, now: NOW, appendMessages: [userMessage("b")] });
    const second = await readJournal(directory);
    expect(second.records.map((record) => record.seq)).toEqual([1, 2]);
    expect(second.warnings).toEqual([]);
  });

  it("restores the missing newline when the tail record is complete JSON", async () => {
    const directory = await tempDir();
    await appendJournal({ directory, nextSeq: 1, now: NOW, appendMessages: [userMessage("a")] });
    const intact = await readFile(journalPath(directory), "utf8");
    // Crash after the record bytes but before the newline.
    await writeFile(journalPath(directory), intact.slice(0, -1), "utf8");

    const result = await readJournal(directory);
    expect(result.records.map((record) => record.seq)).toEqual([1]);
    expect(result.warnings).toEqual([
      "session journal: restored missing newline after last record",
    ]);
    // Boundary restored so the next append cannot concatenate onto the line.
    expect(await readFile(journalPath(directory), "utf8")).toBe(intact);
  });

  it("accepts a journal whose first seq is above 1 (post-truncate monotonic seq)", async () => {
    const directory = await tempDir();
    const next = await appendJournal({
      directory,
      nextSeq: 7,
      now: NOW,
      appendMessages: [userMessage("after-snapshot")],
    });
    expect(next).toBe(8);

    const { records, nextSeq } = await readJournal(directory);
    expect(records.map((record) => record.seq)).toEqual([7]);
    expect(nextSeq).toBe(8);
  });

  it("rejects invalid JSON and seq gaps with the line number", async () => {
    const directory = await tempDir();
    await appendJournal({ directory, nextSeq: 1, now: NOW, appendMessages: [userMessage("a")] });

    const intact = await readFile(journalPath(directory), "utf8");
    await writeFile(journalPath(directory), `${intact}not-json\n`, "utf8");
    await expect(readJournal(directory)).rejects.toThrow(/line 2: invalid JSON/);

    const gap = JSON.stringify({
      schema_version: WAL_SCHEMA,
      seq: 9,
      t: NOW().toISOString(),
      op: "set_model",
      model: { provider: "test", id: "model-a" },
    });
    await writeFile(journalPath(directory), `${intact}${gap}\n`, "utf8");
    await expect(readJournal(directory)).rejects.toThrow(/line 2: expected seq 2, got 9/);
  });

  it("skips unknown future ops while still advancing seq", async () => {
    const directory = await tempDir();
    const unknown = JSON.stringify({
      schema_version: WAL_SCHEMA,
      seq: 1,
      t: NOW().toISOString(),
      op: "hologram_sync",
      payload: { future: true },
    });
    await writeFile(journalPath(directory), `${unknown}\n`, "utf8");

    const next = await appendJournal({
      directory,
      nextSeq: 2,
      now: NOW,
      appendMessages: [userMessage("after-unknown")],
    });
    expect(next).toBe(3);

    const { records, nextSeq } = await readJournal(directory);
    expect(nextSeq).toBe(3);
    expect(records.map((record) => [record.seq, record.op])).toEqual([[2, "append_messages"]]);
  });
});

describe("applyJournal", () => {
  it("rebuilds messages, model, workspace, execution, and the compaction log", async () => {
    const directory = await tempDir();
    let seq = await appendJournal({
      directory,
      nextSeq: 1,
      now: NOW,
      execution: EXECUTION,
      appendMessages: [userMessage("first"), { role: "assistant", content: "reply" }],
    });
    seq = await appendJournal({
      directory,
      nextSeq: seq,
      now: NOW,
      compaction: {
        fact: {
          summary: "squash",
          before_messages: 3,
          after_messages: 1,
          before_tokens: 300,
          after_tokens: 30,
          first_retained_index: 2,
        },
        messages: [userMessage("compacted")],
      },
      model: { provider: "test", id: "model-b" },
      workspace: WORKSPACE,
    });

    const { records } = await readJournal(directory);
    const material = applyJournal(
      { messages: [userMessage("base")], model: { provider: "test", id: "model-a" } },
      records,
    );

    expect(material.messages).toEqual([userMessage("compacted")]);
    expect(material.model).toEqual({ provider: "test", id: "model-b" });
    expect(material.workspace).toEqual(WORKSPACE);
    expect(material.execution).toEqual(EXECUTION);
    expect(material.compactionLog.map((fact) => fact.summary)).toEqual(["squash"]);
    expect(material.lastSeq).toBe(seq - 1);
  });

  it("keeps the base state when replaying an empty record list", () => {
    const base = {
      messages: [userMessage("base")],
      model: { provider: "test", id: "model-a" },
      compactionLog: [
        {
          summary: "earlier",
          before_messages: 2,
          after_messages: 1,
          before_tokens: 20,
          after_tokens: 10,
          first_retained_index: 1,
        },
      ],
    };

    const material = applyJournal(base, []);

    expect(material.messages).toEqual(base.messages);
    expect(material.model).toEqual(base.model);
    expect(material.compactionLog).toEqual(base.compactionLog);
    expect(material.lastSeq).toBe(0);
  });
});

describe("truncateJournal", () => {
  it("empties the journal so the next cold start replays nothing", async () => {
    const directory = await tempDir();
    await appendJournal({ directory, nextSeq: 1, now: NOW, appendMessages: [userMessage("a")] });

    await truncateJournal(directory);

    expect(await readFile(journalPath(directory), "utf8")).toBe("");
    expect(await readJournal(directory)).toEqual({ records: [], nextSeq: 1, warnings: [] });
  });
});

describe("writeJsonAtomicDurable", () => {
  it("writes readable JSON, overwrites in place, and leaves no temp files", async () => {
    const directory = await tempDir();
    const file = path.join(directory, "state.json");

    await writeJsonAtomicDurable(file, { revision: 1 });
    await writeJsonAtomicDurable(file, { revision: 2, nested: { ok: true } });

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ revision: 2, nested: { ok: true } });
    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  it("cleans up its temp file and rethrows when the value is unserializable", async () => {
    const directory = await tempDir();
    const file = path.join(directory, "state.json");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(writeJsonAtomicDurable(file, cyclic)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
});
