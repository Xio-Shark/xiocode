/**
 * Append-only session journal (WAL) overlay for xio-session.v2 snapshots.
 *
 * Full durable truth for a cold start is: state.json + replay(journal.jsonl).
 * Mid-turn checkpoints append O(delta) records; turn boundaries rewrite state
 * and truncate the journal.
 */

import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import type { ChatMessage, ModelInfo } from "./types.ts";

export const WAL_SCHEMA = "xio-session-wal.v1" as const;
export const JOURNAL_FILE = "journal.jsonl";

const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  toolCalls: z.array(toolCallSchema).optional(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
});

const modelSchema = z.object({ provider: z.string(), id: z.string() });

const workspaceSchema = z.object({
  mode: z.enum(["worktree", "main"]),
  lifecycle: z.enum(["provisioning", "active", "retained", "merged", "discarded", "clean_removed"]),
  main_root: z.string(),
  worktree_path: z.string().optional(),
  branch: z.string().optional(),
  base_ref: z.string().optional(),
  baseline_tree: z.string().optional(),
  repo_id: z.string().optional(),
  session_id: z.string().optional(),
  epoch: z.number().int().nonnegative(),
});

const checkpointSchema = z.object({
  ref: z.string(),
  commit: z.string(),
  head: z.string(),
  tree: z.string(),
});

const executionSchema = z.object({
  phase: z.enum(["idle", "turn_started", "awaiting_provider", "tool_batch_running", "closing"]),
  turn_id: z.string().optional(),
  checkpoint: checkpointSchema.optional(),
  pending_tools: z.array(z.object({
    id: z.string(),
    name: z.string(),
    risk: z.string().optional(),
  })).optional(),
  interrupted_at: z.string().datetime().optional(),
});

const walRecordSchema = z.object({
  schema_version: z.literal(WAL_SCHEMA),
  seq: z.number().int().positive(),
  t: z.string().datetime(),
  op: z.enum(["execution", "append_messages", "set_messages", "set_model", "set_workspace"]),
  execution: executionSchema.optional(),
  messages: z.array(messageSchema).optional(),
  model: modelSchema.optional(),
  workspace: workspaceSchema.optional(),
});

export type WalRecord = z.infer<typeof walRecordSchema>;
export type WalExecution = z.infer<typeof executionSchema>;
export type WalWorkspace = z.infer<typeof workspaceSchema>;

export type JournalMaterial = Readonly<{
  messages: ChatMessage[];
  model?: ModelInfo;
  workspace?: WalWorkspace;
  execution?: WalExecution;
  lastSeq: number;
}>;

export type JournalAppendInput = Readonly<{
  directory: string;
  nextSeq: number;
  now: () => Date;
  execution?: WalExecution;
  /** Newly appended messages only (not the full history). */
  appendMessages?: readonly ChatMessage[];
  /** Full message list replace (compaction); use sparingly mid-turn. */
  setMessages?: readonly ChatMessage[];
  model?: ModelInfo;
  workspace?: WalWorkspace;
}>;

export function journalPath(directory: string): string {
  return path.join(directory, JOURNAL_FILE);
}

export function encodeWalRecords(input: JournalAppendInput): WalRecord[] {
  const t = input.now().toISOString();
  const records: WalRecord[] = [];
  let seq = input.nextSeq;
  if (input.execution) {
    records.push(walRecordSchema.parse({
      schema_version: WAL_SCHEMA,
      seq: seq++,
      t,
      op: "execution",
      execution: input.execution,
    }));
  }
  if (input.appendMessages && input.appendMessages.length > 0) {
    records.push(walRecordSchema.parse({
      schema_version: WAL_SCHEMA,
      seq: seq++,
      t,
      op: "append_messages",
      messages: input.appendMessages,
    }));
  }
  if (input.setMessages) {
    records.push(walRecordSchema.parse({
      schema_version: WAL_SCHEMA,
      seq: seq++,
      t,
      op: "set_messages",
      messages: input.setMessages,
    }));
  }
  if (input.model) {
    records.push(walRecordSchema.parse({
      schema_version: WAL_SCHEMA,
      seq: seq++,
      t,
      op: "set_model",
      model: { provider: input.model.provider, id: input.model.id },
    }));
  }
  if (input.workspace) {
    records.push(walRecordSchema.parse({
      schema_version: WAL_SCHEMA,
      seq: seq++,
      t,
      op: "set_workspace",
      workspace: input.workspace,
    }));
  }
  return records;
}

/** Append WAL lines with fsync. Returns the next available seq. */
export async function appendJournal(input: JournalAppendInput): Promise<number> {
  const records = encodeWalRecords(input);
  if (records.length === 0) return input.nextSeq;
  const body = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const file = journalPath(input.directory);
  const handle = await open(file, "a");
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return records[records.length - 1]!.seq + 1;
}

export async function readJournal(directory: string): Promise<readonly WalRecord[]> {
  const file = journalPath(directory);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  if (text.trim().length === 0) return [];
  const records: WalRecord[] = [];
  let expectedSeq = 1;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`corrupt session journal at line ${index + 1}: invalid JSON`);
    }
    const record = walRecordSchema.safeParse(parsed);
    if (!record.success) {
      throw new Error(`corrupt session journal at line ${index + 1}: ${record.error.message}`);
    }
    if (record.data.seq !== expectedSeq) {
      throw new Error(
        `corrupt session journal at line ${index + 1}: expected seq ${expectedSeq}, got ${record.data.seq}`,
      );
    }
    records.push(record.data);
    expectedSeq = record.data.seq + 1;
  }
  return records;
}

export function applyJournal(
  base: Readonly<{
    messages: readonly ChatMessage[];
    model?: ModelInfo;
    workspace?: WalWorkspace;
    execution?: WalExecution;
  }>,
  records: readonly WalRecord[],
): JournalMaterial {
  let messages = [...base.messages];
  let model = base.model;
  let workspace = base.workspace;
  let execution = base.execution;
  let lastSeq = 0;
  for (const record of records) {
    lastSeq = record.seq;
    switch (record.op) {
      case "execution":
        if (record.execution) execution = record.execution;
        break;
      case "append_messages":
        if (record.messages) messages.push(...(record.messages as ChatMessage[]));
        break;
      case "set_messages":
        if (record.messages) messages = [...(record.messages as ChatMessage[])];
        break;
      case "set_model":
        if (record.model) model = record.model;
        break;
      case "set_workspace":
        if (record.workspace) workspace = record.workspace;
        break;
    }
  }
  return { messages, model, workspace, execution, lastSeq };
}

/** Truncate journal after a durable full snapshot (empty file + fsync). */
export async function truncateJournal(directory: string): Promise<void> {
  const file = journalPath(directory);
  const handle = await open(file, "w");
  try {
    await handle.truncate(0);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Atomic JSON write with fsync of the temp file before rename.
 * Best-effort directory fsync after rename (may be unsupported on some FS).
 */
export async function writeJsonAtomicDurable(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    await fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best-effort (Windows / some mounts).
  }
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}
