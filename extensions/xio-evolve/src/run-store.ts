import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RunMetadata } from "./types.ts";

export type RunStoreOptions = Readonly<{
  root?: string;
  now?: () => Date;
  randomId?: () => string;
}>;

export type RunRecord = Readonly<{
  run_id: string;
  path: string;
  metadata: RunMetadata;
}>;

const DEFAULT_PROVIDER = "unknown";
const DEFAULT_MODEL = "unknown";

export class RunStore {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly randomId: () => string;

  constructor(options: RunStoreOptions = {}) {
    this.root = expandHome(options.root ?? "~/.xiocode/runs");
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => randomUUID());
  }

  async createRun(input: Partial<RunMetadata> = {}): Promise<RunRecord> {
    await mkdir(this.root, { recursive: true });
    const metadata = this.createMetadata(input);
    const runPath = this.runPath(metadata.run_id);
    await mkdir(runPath, { recursive: true });
    await this.writeJson(metadata.run_id, "metadata.json", metadata);
    return { run_id: metadata.run_id, path: runPath, metadata };
  }

  async listRecent(limit: number): Promise<readonly RunRecord[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const records = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.readRecord(entry.name)));
    return records
      .filter((record): record is RunRecord => record !== null)
      .sort((a, b) => b.metadata.started_at.localeCompare(a.metadata.started_at))
      .slice(0, limit);
  }

  async writeJson(runId: string, fileName: string, value: unknown): Promise<void> {
    await mkdir(this.runPath(runId), { recursive: true });
    await writeFile(this.filePath(runId, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  async appendJsonl(runId: string, fileName: string, value: unknown): Promise<void> {
    await this.appendJsonlBatch(runId, fileName, [value]);
  }

  async appendJsonlBatch(runId: string, fileName: string, values: readonly unknown[]): Promise<void> {
    if (values.length === 0) {
      return;
    }
    await mkdir(this.runPath(runId), { recursive: true });
    await writeFile(
      this.filePath(runId, fileName),
      values.map((value) => `${JSON.stringify(value)}\n`).join(""),
      { encoding: "utf8", flag: "a" },
    );
  }

  async writeText(runId: string, fileName: string, value: string): Promise<void> {
    await mkdir(this.runPath(runId), { recursive: true });
    await writeFile(this.filePath(runId, fileName), value, "utf8");
  }

  runPath(runId: string): string {
    return path.join(this.root, runId);
  }

  rootPath(): string {
    return this.root;
  }

  filePath(runId: string, fileName: string): string {
    return path.join(this.runPath(runId), fileName);
  }

  private createMetadata(input: Partial<RunMetadata>): RunMetadata {
    const startedAt = input.started_at ?? this.now().toISOString();
    return {
      run_id: input.run_id ?? `run-${startedAt.replace(/[:.]/g, "-")}-${this.randomId().slice(0, 8)}`,
      provider: input.provider ?? DEFAULT_PROVIDER,
      model: input.model ?? DEFAULT_MODEL,
      started_at: startedAt,
    };
  }

  private async readRecord(runId: string): Promise<RunRecord | null> {
    try {
      const metadata = JSON.parse(await readFile(this.filePath(runId, "metadata.json"), "utf8")) as RunMetadata;
      return { run_id: runId, path: this.runPath(runId), metadata };
    } catch {
      return null;
    }
  }
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
