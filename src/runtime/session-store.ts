import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  appendJournal,
  applyJournal,
  compactionFactSchema,
  readJournal,
  truncateJournal,
  writeJsonAtomicDurable,
} from "./session-wal.ts";
import type { WalCompactionFact } from "./session-wal.ts";
import type { SessionCompactionFact } from "./context-compaction.ts";
import type { ChatMessage, ModelInfo } from "./types.ts";

export type { SessionCompactionFact } from "./context-compaction.ts";

const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const STATE_FILE = "state.json";

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
const timestampSchema = z.string().datetime();

const workspaceSchema = z.object({
  mode: z.enum(["worktree", "main"]),
  lifecycle: z.enum(["provisioning", "active", "retained", "merged", "discarded", "clean_removed"]),
  main_root: z.string(),
  worktree_path: z.string().optional(),
  branch: z.string().optional(),
  base_ref: z.string().optional(),
  /** Visible-tree oid at session start; optional on legacy v2 records. */
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
  interrupted_at: timestampSchema.optional(),
});

const metadataV1Schema = z.object({
  schema_version: z.literal("xio-session.v1"),
  id: z.string().regex(SESSION_ID),
  model: modelSchema,
  cwd: z.string(),
  main_root: z.string(),
  worktree_path: z.string().optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

const metadataV2Schema = z.object({
  schema_version: z.literal("xio-session.v2"),
  revision: z.number().int().positive(),
  id: z.string().regex(SESSION_ID),
  model: modelSchema,
  cwd: z.string(),
  main_root: z.string(),
  worktree_path: z.string().optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  workspace: workspaceSchema,
  execution: executionSchema,
});

const stateV2Schema = metadataV2Schema.extend({
  messages: z.array(messageSchema),
  /** Auditable compaction facts; optional for forward/back compat with older v2 files. */
  compaction_log: z.array(compactionFactSchema).optional(),
});

export type SessionWorkspace = z.infer<typeof workspaceSchema>;
export type SessionExecution = z.infer<typeof executionSchema>;
export type SessionMetadataV1 = z.infer<typeof metadataV1Schema>;
export type SessionMetadataV2 = z.infer<typeof metadataV2Schema>;
export type SessionMetadata = SessionMetadataV1 | SessionMetadataV2;

/** Snapshot rewrites state.json; journal appends O(delta) WAL records. */
export type SessionDurability = "snapshot" | "journal";

export type StoredSession = Readonly<{
  metadata: SessionMetadata;
  messages: readonly ChatMessage[];
  workspace?: SessionWorkspace;
  execution?: SessionExecution;
  compactionLog?: readonly WalCompactionFact[];
}>;

export type SaveSessionInput = Readonly<{
  id: string;
  model: ModelInfo;
  cwd: string;
  mainRoot: string;
  worktreePath?: string;
  messages: readonly ChatMessage[];
  createdAt?: string;
  workspace?: SessionWorkspace;
  execution?: SessionExecution;
  /**
   * When set, append a durable `compaction` journal record before updating the
   * projection snapshot. Required for audit/resume of context compaction.
   */
  compaction?: SessionCompactionFact;
  /**
   * `snapshot` (default): atomic full state.json + truncate journal.
   * `journal`: append-only WAL for mid-turn checkpoints (O(delta) when the
   * process already holds a live cursor). Falls back to snapshot when the
   * message history is not a pure append of the last materialization.
   */
  durability?: SessionDurability;
}>;

export function decodeSessionState(value: unknown): StoredSession {
  const state = stateV2Schema.parse(value);
  const { messages, compaction_log: compactionLog, ...metadata } = state;
  return {
    metadata,
    messages: messages as ChatMessage[],
    workspace: state.workspace,
    execution: state.execution,
    ...(compactionLog && compactionLog.length > 0 ? { compactionLog } : {}),
  };
}

export function toWalCompactionFact(
  fact: SessionCompactionFact,
  timestamp?: string,
): WalCompactionFact {
  return compactionFactSchema.parse({
    summary: fact.summary,
    before_messages: fact.beforeMessages,
    after_messages: fact.afterMessages,
    before_tokens: fact.beforeTokens,
    after_tokens: fact.afterTokens,
    first_retained_index: fact.firstRetainedIndex,
    ...(fact.timestamp || timestamp
      ? { t: fact.timestamp ?? timestamp }
      : {}),
  });
}

export class SessionStore {
  readonly #root: string;
  readonly #now: () => Date;
  /** Next journal seq per session id (1-based next write). */
  readonly #nextSeq = new Map<string, number>();
  /**
   * In-process materialized view (snapshot + journal). When present, journal
   * saves are O(delta): no disk reload and no full-history prefix compare.
   */
  readonly #live = new Map<string, StoredSession>();

  constructor(options: Readonly<{ root: string; now?: () => Date }>) {
    this.#root = path.resolve(options.root);
    this.#now = options.now ?? (() => new Date());
  }

  createId(): string {
    return randomUUID().replaceAll("-", "");
  }

  async acquireLease(id: string): Promise<() => Promise<void>> {
    assertSessionId(id);
    const leaseDirectory = path.join(this.#root, ".leases");
    const leasePath = path.join(leaseDirectory, `${id}.json`);
    const token = randomUUID();
    await mkdir(leaseDirectory, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(leasePath, JSON.stringify({ pid: process.pid, token }), { encoding: "utf8", flag: "wx" });
        return async () => {
          const current = JSON.parse(await readFile(leasePath, "utf8")) as { token?: unknown };
          if (current.token !== token) throw new Error(`session lease ownership changed for ${id}`);
          await rm(leasePath);
        };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const holder = await readLease(leasePath);
        if (holder && isProcessAlive(holder.pid)) {
          throw new Error(`session ${id} is already active in process ${holder.pid}`);
        }
        await rm(leasePath, { force: true });
      }
    }
    throw new Error(`failed to acquire session lease for ${id}`);
  }

  async save(input: SaveSessionInput): Promise<StoredSession> {
    assertSessionId(input.id);
    if (input.durability === "journal") {
      return this.#saveJournal(input);
    }
    return this.#saveSnapshot(input);
  }

  async load(id: string): Promise<StoredSession> {
    assertSessionId(id);
    try {
      return await this.#loadVersioned(id);
    } catch (error) {
      throw new Error(`failed to load session ${id}: ${errorMessage(error)}`);
    }
  }

  async list(): Promise<readonly SessionMetadata[]> {
    let entries;
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const sessions: SessionMetadata[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
      sessions.push((await this.#loadVersioned(entry.name)).metadata);
    }
    return sessions.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  async latest(mainRoot?: string): Promise<StoredSession | undefined> {
    const sessions = await this.list();
    const metadata = mainRoot
      ? sessions.find((item) => path.resolve(item.main_root) === path.resolve(mainRoot))
      : sessions[0];
    return metadata ? this.load(metadata.id) : undefined;
  }

  async remove(id: string): Promise<void> {
    assertSessionId(id);
    this.#forget(id);
    await rm(this.#sessionDirectory(id), { recursive: true, force: true });
  }

  async #saveSnapshot(input: SaveSessionInput): Promise<StoredSession> {
    const existing = this.#live.get(input.id) ?? await this.#loadIfPresent(input.id);
    const now = this.#now().toISOString();
    const workspace = workspaceSchema.parse(input.workspace ?? existing?.workspace ?? defaultWorkspace(input));
    const execution = executionSchema.parse(input.execution ?? existing?.execution ?? { phase: "idle" });
    const directory = this.#sessionDirectory(input.id);
    await mkdir(directory, { recursive: true });

    // Crash-safe order: append durable compaction fact (+ projection) to the
    // journal before rewriting state. Resume can rebuild from journal alone if
    // the process dies between append and snapshot truncate.
    if (input.compaction) {
      let nextSeq = this.#nextSeq.get(input.id);
      if (nextSeq === undefined) {
        const journal = await readJournal(directory);
        nextSeq = journal.nextSeq;
      }
      nextSeq = await appendJournal({
        directory,
        nextSeq,
        now: this.#now,
        compaction: {
          fact: toWalCompactionFact(input.compaction, now),
          messages: input.messages,
        },
      });
      this.#nextSeq.set(input.id, nextSeq);
    }

    const priorLog = existing?.compactionLog ?? [];
    const compactionLog = input.compaction
      ? [...priorLog, toWalCompactionFact(input.compaction, now)].slice(-32)
      : [...priorLog];

    const state = stateV2Schema.parse({
      schema_version: "xio-session.v2",
      revision: previousRevision(existing) + 1,
      id: input.id,
      model: { provider: input.model.provider, id: input.model.id },
      cwd: input.cwd,
      main_root: input.mainRoot,
      worktree_path: input.worktreePath ?? workspace.worktree_path,
      created_at: input.createdAt ?? existing?.metadata.created_at ?? now,
      updated_at: now,
      workspace,
      execution,
      messages: input.messages,
      ...(compactionLog.length > 0 ? { compaction_log: compactionLog } : {}),
    });
    await writeJsonAtomicDurable(path.join(directory, STATE_FILE), state);
    await truncateJournal(directory);
    const stored = decodeSessionState(state);
    this.#remember(input.id, stored, 1);
    return stored;
  }

  async #saveJournal(input: SaveSessionInput): Promise<StoredSession> {
    // Warm path: in-memory authority — no disk reload, no O(history) prefix scan.
    const warm = this.#live.has(input.id);
    let existing = this.#live.get(input.id);
    if (!existing) {
      existing = await this.#loadIfPresent(input.id);
    }
    if (!existing || existing.metadata.schema_version !== "xio-session.v2") {
      // First write or still on v1: must establish a durable snapshot baseline.
      return this.#saveSnapshot(input);
    }

    // Compaction always takes the snapshot path (append fact, then rewrite).
    if (input.compaction) {
      return this.#saveSnapshot(input);
    }

    const priorMessages = existing.messages;
    const priorCount = priorMessages.length;
    // Warm: trust process-local append-only authority (agent loop only pushes mid-turn;
    // compaction / replace always take snapshot durability). Cold: content prefix check once.
    const isPureAppend = input.messages.length >= priorCount
      && (warm || messagesPrefixEqual(priorMessages, input.messages, priorCount));

    if (!isPureAppend) {
      return this.#saveSnapshot(input);
    }

    const appendMessages = input.messages.slice(priorCount);
    const workspace = input.workspace
      ? workspaceSchema.parse(input.workspace)
      : existing.workspace;
    const execution = input.execution
      ? executionSchema.parse(input.execution)
      : existing.execution;
    const modelChanged = input.model.provider !== existing.metadata.model.provider
      || input.model.id !== existing.metadata.model.id;
    const workspaceChanged = input.workspace !== undefined
      && !workspaceEqual(input.workspace, existing.workspace);

    if (
      appendMessages.length === 0
      && !input.execution
      && !modelChanged
      && !workspaceChanged
    ) {
      return existing;
    }

    const directory = this.#sessionDirectory(input.id);
    await mkdir(directory, { recursive: true });
    let nextSeq = this.#nextSeq.get(input.id);
    if (nextSeq === undefined) {
      const journal = await readJournal(directory);
      nextSeq = journal.nextSeq;
    }

    nextSeq = await appendJournal({
      directory,
      nextSeq,
      now: this.#now,
      ...(input.execution ? { execution } : {}),
      ...(appendMessages.length > 0 ? { appendMessages } : {}),
      ...(modelChanged ? { model: input.model } : {}),
      ...(workspaceChanged && workspace ? { workspace } : {}),
    });

    const metadata: SessionMetadataV2 = {
      ...existing.metadata,
      model: { provider: input.model.provider, id: input.model.id },
      cwd: input.cwd,
      main_root: input.mainRoot,
      worktree_path: input.worktreePath ?? workspace?.worktree_path ?? existing.metadata.worktree_path,
      updated_at: this.#now().toISOString(),
      workspace: workspace ?? existing.workspace!,
      execution: execution ?? existing.execution ?? { phase: "idle" },
    };
    const stored: StoredSession = {
      metadata,
      messages: input.messages,
      workspace: metadata.workspace,
      execution: metadata.execution,
      ...(existing.compactionLog ? { compactionLog: existing.compactionLog } : {}),
    };
    this.#remember(input.id, stored, nextSeq);
    return stored;
  }

  #remember(id: string, session: StoredSession, nextSeq: number): void {
    this.#live.set(id, session);
    this.#nextSeq.set(id, nextSeq);
  }

  #forget(id: string): void {
    this.#live.delete(id);
    this.#nextSeq.delete(id);
  }

  async #loadVersioned(id: string): Promise<StoredSession> {
    const directory = this.#sessionDirectory(id);
    try {
      const text = await readFile(path.join(directory, STATE_FILE), "utf8");
      const base = decodeSessionState(JSON.parse(text));
      const journal = await readJournal(directory);
      if (journal.records.length === 0) {
        this.#remember(id, base, journal.nextSeq);
        return base;
      }
      const applied = applyJournal({
        messages: base.messages,
        model: base.metadata.model,
        workspace: base.workspace,
        execution: base.execution,
        compactionLog: base.compactionLog,
      }, journal.records);
      if (base.metadata.schema_version !== "xio-session.v2") {
        throw new Error("journal present without xio-session.v2 snapshot");
      }
      const lastJournalTime = journal.records[journal.records.length - 1]?.t;
      const metadata: SessionMetadataV2 = {
        ...base.metadata,
        model: applied.model ?? base.metadata.model,
        workspace: applied.workspace ?? base.workspace!,
        execution: applied.execution ?? base.execution ?? { phase: "idle" },
        // Journal advances content; revision stays snapshot revision until next snapshot.
        ...(lastJournalTime ? { updated_at: lastJournalTime } : {}),
      };
      const stored: StoredSession = {
        metadata,
        messages: applied.messages,
        workspace: metadata.workspace,
        execution: metadata.execution,
        ...(applied.compactionLog.length > 0 ? { compactionLog: applied.compactionLog } : {}),
      };
      this.#remember(id, stored, journal.nextSeq);
      return stored;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const v1 = await this.#loadV1(directory);
    this.#live.set(id, v1);
    return v1;
  }

  async #loadV1(directory: string): Promise<StoredSession> {
    const [metadataText, messagesText] = await Promise.all([
      readFile(path.join(directory, "metadata.json"), "utf8"),
      readFile(path.join(directory, "messages.json"), "utf8"),
    ]);
    const metadata = metadataV1Schema.parse(JSON.parse(metadataText));
    const messages = z.array(messageSchema).parse(JSON.parse(messagesText)) as ChatMessage[];
    return { metadata, messages };
  }

  async #loadIfPresent(id: string): Promise<StoredSession | undefined> {
    try {
      return await this.#loadVersioned(id);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  #sessionDirectory(id: string): string {
    return path.join(this.#root, id);
  }
}

async function readLease(filePath: string): Promise<{ pid: number } | undefined> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as { pid?: unknown };
    return typeof value.pid === "number" && Number.isInteger(value.pid) ? { pid: value.pid } : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function defaultWorkspace(input: SaveSessionInput): SessionWorkspace {
  return input.worktreePath
    ? {
        mode: "worktree",
        lifecycle: "active",
        main_root: input.mainRoot,
        worktree_path: input.worktreePath,
        session_id: input.id,
        epoch: 0,
      }
    : { mode: "main", lifecycle: "active", main_root: input.mainRoot, epoch: 0 };
}

function previousRevision(session: StoredSession | undefined): number {
  return session?.metadata.schema_version === "xio-session.v2" ? session.metadata.revision : 0;
}

/** True when `next` starts with the first `count` messages of `prior` (by JSON identity). */
function messagesPrefixEqual(
  prior: readonly ChatMessage[],
  next: readonly ChatMessage[],
  count: number,
): boolean {
  if (prior.length < count || next.length < count) return false;
  for (let index = 0; index < count; index += 1) {
    if (JSON.stringify(prior[index]) !== JSON.stringify(next[index])) return false;
  }
  return true;
}

function workspaceEqual(
  left: SessionWorkspace | undefined,
  right: SessionWorkspace | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.mode === right.mode
    && left.lifecycle === right.lifecycle
    && left.main_root === right.main_root
    && left.worktree_path === right.worktree_path
    && left.branch === right.branch
    && left.base_ref === right.base_ref
    && left.baseline_tree === right.baseline_tree
    && left.repo_id === right.repo_id
    && left.session_id === right.session_id
    && left.epoch === right.epoch;
}

function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id)) throw new Error(`invalid session id: ${id}`);
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
