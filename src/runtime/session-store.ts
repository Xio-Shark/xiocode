import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { ChatMessage, ModelInfo } from "./types.ts";

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
});

export type SessionWorkspace = z.infer<typeof workspaceSchema>;
export type SessionExecution = z.infer<typeof executionSchema>;
export type SessionMetadataV1 = z.infer<typeof metadataV1Schema>;
export type SessionMetadataV2 = z.infer<typeof metadataV2Schema>;
export type SessionMetadata = SessionMetadataV1 | SessionMetadataV2;

export type StoredSession = Readonly<{
  metadata: SessionMetadata;
  messages: readonly ChatMessage[];
  workspace?: SessionWorkspace;
  execution?: SessionExecution;
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
}>;

export function decodeSessionState(value: unknown): StoredSession {
  const state = stateV2Schema.parse(value);
  const { messages, ...metadata } = state;
  return { metadata, messages: messages as ChatMessage[], workspace: state.workspace, execution: state.execution };
}

export class SessionStore {
  readonly #root: string;
  readonly #now: () => Date;

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
    const existing = await this.#loadIfPresent(input.id);
    const now = this.#now().toISOString();
    const workspace = workspaceSchema.parse(input.workspace ?? existing?.workspace ?? defaultWorkspace(input));
    const execution = executionSchema.parse(input.execution ?? existing?.execution ?? { phase: "idle" });
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
    });
    const directory = this.#sessionDirectory(input.id);
    await mkdir(directory, { recursive: true });
    await writeJsonAtomic(path.join(directory, STATE_FILE), state);
    return decodeSessionState(state);
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
    await rm(this.#sessionDirectory(id), { recursive: true, force: true });
  }

  async #loadVersioned(id: string): Promise<StoredSession> {
    const directory = this.#sessionDirectory(id);
    try {
      const text = await readFile(path.join(directory, STATE_FILE), "utf8");
      return decodeSessionState(JSON.parse(text));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return this.#loadV1(directory);
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

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
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
