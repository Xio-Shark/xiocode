import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { ChatMessage, ModelInfo } from "./types.ts";

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

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

const metadataSchema = z.object({
  schema_version: z.literal("xio-session.v1"),
  id: z.string().regex(SESSION_ID),
  model: z.object({ provider: z.string(), id: z.string() }),
  cwd: z.string(),
  main_root: z.string(),
  worktree_path: z.string().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type SessionMetadata = z.infer<typeof metadataSchema>;

export type StoredSession = Readonly<{
  metadata: SessionMetadata;
  messages: readonly ChatMessage[];
}>;

export type SaveSessionInput = Readonly<{
  id: string;
  model: ModelInfo;
  cwd: string;
  mainRoot: string;
  worktreePath?: string;
  messages: readonly ChatMessage[];
  createdAt?: string;
}>;

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

  async save(input: SaveSessionInput): Promise<StoredSession> {
    assertSessionId(input.id);
    const existing = await this.#readMetadataIfPresent(input.id);
    const now = this.#now().toISOString();
    const metadata = metadataSchema.parse({
      schema_version: "xio-session.v1",
      id: input.id,
      model: { provider: input.model.provider, id: input.model.id },
      cwd: input.cwd,
      main_root: input.mainRoot,
      worktree_path: input.worktreePath,
      created_at: input.createdAt ?? existing?.created_at ?? now,
      updated_at: now,
    });
    const messages = z.array(messageSchema).parse(input.messages) as ChatMessage[];
    const directory = this.#sessionDirectory(input.id);
    await mkdir(directory, { recursive: true });
    await writeJsonAtomic(path.join(directory, "messages.json"), messages);
    await writeJsonAtomic(path.join(directory, "metadata.json"), metadata);
    return { metadata, messages };
  }

  async load(id: string): Promise<StoredSession> {
    assertSessionId(id);
    const directory = this.#sessionDirectory(id);
    try {
      const [metadataText, messagesText] = await Promise.all([
        readFile(path.join(directory, "metadata.json"), "utf8"),
        readFile(path.join(directory, "messages.json"), "utf8"),
      ]);
      const metadata = metadataSchema.parse(JSON.parse(metadataText));
      const messages = z.array(messageSchema).parse(JSON.parse(messagesText)) as ChatMessage[];
      return { metadata, messages };
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
      const metadata = await this.#readMetadata(entry.name);
      sessions.push(metadata);
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

  async #readMetadata(id: string): Promise<SessionMetadata> {
    try {
      const text = await readFile(path.join(this.#sessionDirectory(id), "metadata.json"), "utf8");
      return metadataSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new Error(`failed to read session metadata ${id}: ${errorMessage(error)}`);
    }
  }

  async #readMetadataIfPresent(id: string): Promise<SessionMetadata | undefined> {
    try {
      return await this.#readMetadata(id);
    } catch (error) {
      if (errorMessage(error).includes("ENOENT")) return undefined;
      throw error;
    }
  }

  #sessionDirectory(id: string): string {
    return path.join(this.#root, id);
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
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
