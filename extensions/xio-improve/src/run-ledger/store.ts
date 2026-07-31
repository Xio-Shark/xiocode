import { appendFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SecretRedactor } from "../../../xio-evolve/src/secret-redactor.ts";
import { replayPendingEvents } from "./reducer.ts";
import {
  decodeRunEvent,
  decodeRunState,
  LedgerDecodeError,
  type ImprovementRunEvent,
  type ImprovementRunState,
  type LedgerReceipt,
} from "./types.ts";

/** Bounded reads: malformed or oversize control files fail closed (R7). */
const MAX_STATE_BYTES = 256 * 1024;
const MAX_EVENTS_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;

const REDACTOR = new SecretRedactor();

export class LedgerStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerStoreError";
  }
}

export class LedgerLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerLockError";
  }
}

export type RunLedgerStoreOptions = Readonly<{
  /** Ledger root, default ~/.xiocode/improve/runs (never a candidate worktree). */
  root?: string;
}>;

/**
 * Durable improvement-run store: state.json (atomic replace), events.jsonl
 * (append-only WAL), receipts/, diagnostics.jsonl. Claims are directories —
 * `mkdir` is the CAS that makes exactly one process win a run id.
 */
export class RunLedgerStore {
  readonly #root: string;

  constructor(options: RunLedgerStoreOptions = {}) {
    this.#root = path.resolve(options.root ?? path.join(os.homedir(), ".xiocode", "improve", "runs"));
  }

  get root(): string {
    return this.#root;
  }

  runDir(runId: string): string {
    const dir = path.resolve(this.#root, runId);
    // Root containment: run ids must not traverse outside the ledger root.
    if (dir !== this.#root && !dir.startsWith(`${this.#root}${path.sep}`)) {
      throw new LedgerStoreError(`run id escapes ledger root: ${runId}`);
    }
    if (path.dirname(dir) !== this.#root) {
      throw new LedgerStoreError(`run id must be a single path segment: ${runId}`);
    }
    return dir;
  }

  /** Atomically claims a run id; false when the directory already exists. */
  async createRun(state: ImprovementRunState): Promise<boolean> {
    const dir = this.runDir(state.run_id);
    await mkdir(this.#root, { recursive: true });
    try {
      await mkdir(dir);
    } catch (error) {
      if (isCode(error, "EEXIST")) {
        return false;
      }
      throw error;
    }
    await mkdir(path.join(dir, "receipts"), { recursive: true });
    await this.#writeStateAtomic(dir, state);
    return true;
  }

  /** Commit protocol: append event (WAL intent) first, then replace state. */
  async commitTransition(state: ImprovementRunState, event: ImprovementRunEvent): Promise<void> {
    if (event.state_revision !== state.revision) {
      throw new LedgerStoreError(
        `event revision ${event.state_revision} does not match state revision ${state.revision}`,
      );
    }
    const dir = this.runDir(state.run_id);
    await this.#assertRegularOrMissing(path.join(dir, "events.jsonl"));
    await appendFile(
      path.join(dir, "events.jsonl"),
      `${JSON.stringify(REDACTOR.redact(event))}\n`,
      "utf8",
    );
    await this.#writeStateAtomic(dir, state);
  }

  /**
   * Loads a run and settles any incomplete transition (event appended but
   * state replace lost). Replay failures and malformed files fail closed.
   */
  async loadRun(runId: string): Promise<Readonly<{
    state: ImprovementRunState;
    events: readonly ImprovementRunEvent[];
    repaired: boolean;
  }>> {
    const dir = this.runDir(runId);
    const stateRaw = await this.#readBounded(path.join(dir, "state.json"), MAX_STATE_BYTES);
    const state = decodeRunState(parseJson(stateRaw, "state.json"));
    if (state.run_id !== runId) {
      throw new LedgerStoreError(`state.json run_id "${state.run_id}" does not match directory "${runId}"`);
    }
    const events = await this.#readEvents(dir);
    assertMonotonic(events, runId);
    const settled = replayPendingEvents(state, events);
    const repaired = settled.revision !== state.revision;
    if (repaired) {
      await this.#writeStateAtomic(dir, settled);
      await this.appendDiagnostic(runId, {
        code: "incomplete_transition_settled",
        detail: `state settled from revision ${state.revision} to ${settled.revision} via event replay`,
      });
    }
    return { state: settled, events, repaired };
  }

  async listRunIds(): Promise<readonly string[]> {
    let entries;
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  }

  async writeReceipt(runId: string, name: string, receipt: LedgerReceipt): Promise<string> {
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(name)) {
      throw new LedgerStoreError(`invalid receipt name: ${name}`);
    }
    const dir = path.join(this.runDir(runId), "receipts");
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, name);
    await this.#assertRegularOrMissing(target);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, `${JSON.stringify(REDACTOR.redact(receipt), null, 2)}\n`, "utf8");
    await rename(tmp, target);
    return `receipts/${name}`;
  }

  async readReceipt(runId: string, ref: string): Promise<unknown> {
    if (!ref.startsWith("receipts/") || ref.includes("..")) {
      throw new LedgerStoreError(`invalid receipt ref: ${ref}`);
    }
    const target = path.join(this.runDir(runId), ref);
    const raw = await this.#readBounded(target, MAX_RECEIPT_BYTES);
    return parseJson(raw, ref);
  }

  /** Failure observability (R7.3): cleanup/repair problems are diagnostics, not silence. */
  async appendDiagnostic(runId: string, entry: Readonly<{ code: string; detail: string }>): Promise<void> {
    const dir = this.runDir(runId);
    const record = { ...entry, at: new Date().toISOString() };
    await appendFile(
      path.join(dir, "diagnostics.jsonl"),
      `${JSON.stringify(REDACTOR.redact(record))}\n`,
      "utf8",
    );
  }

  async readDiagnostics(runId: string): Promise<readonly Readonly<{ code: string; detail: string; at: string }>[]> {
    const target = path.join(this.runDir(runId), "diagnostics.jsonl");
    let raw: string;
    try {
      raw = await this.#readBounded(target, MAX_EVENTS_BYTES);
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => parseJson(line, "diagnostics.jsonl") as { code: string; detail: string; at: string });
  }

  /**
   * Per-run single-writer lock. Fails when another live process holds it;
   * stale locks (dead pid) are taken over with a diagnostic entry.
   */
  async acquireLock(runId: string): Promise<() => Promise<void>> {
    const dir = this.runDir(runId);
    const lockPath = path.join(dir, ".lock");
    const payload = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
    try {
      await writeFile(lockPath, payload, { flag: "wx" });
    } catch (error) {
      if (!isCode(error, "EEXIST")) {
        throw error;
      }
      const holder = await this.#readLockHolder(lockPath);
      if (holder !== undefined && isProcessAlive(holder)) {
        throw new LedgerLockError(
          `run ${runId} is locked by live process ${holder}; refusing concurrent advance`,
        );
      }
      await this.appendDiagnostic(runId, {
        code: "stale_lock_takeover",
        detail: `lock held by ${holder === undefined ? "unreadable holder" : `dead pid ${holder}`}; taken over by pid ${process.pid}`,
      });
      const tmp = `${lockPath}.tmp`;
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, lockPath);
    }
    return async () => {
      await rm(lockPath, { force: true });
    };
  }

  async #readLockHolder(lockPath: string): Promise<number | undefined> {
    try {
      const raw = await this.#readBounded(lockPath, 4096);
      const parsed = JSON.parse(raw) as { pid?: unknown };
      return typeof parsed.pid === "number" ? parsed.pid : undefined;
    } catch {
      return undefined;
    }
  }

  async #readEvents(dir: string): Promise<readonly ImprovementRunEvent[]> {
    const target = path.join(dir, "events.jsonl");
    let raw: string;
    try {
      raw = await this.#readBounded(target, MAX_EVENTS_BYTES);
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => decodeRunEvent(parseJson(line, "events.jsonl")));
  }

  async #writeStateAtomic(dir: string, state: ImprovementRunState): Promise<void> {
    const target = path.join(dir, "state.json");
    await this.#assertRegularOrMissing(target);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, `${JSON.stringify(REDACTOR.redact(state), null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }

  /** Symlinked control files are rejected (R7 / identity replacement). */
  async #assertRegularOrMissing(target: string): Promise<void> {
    try {
      const stat = await lstat(target);
      if (!stat.isFile()) {
        throw new LedgerStoreError(`refusing non-regular control file: ${target}`);
      }
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
  }

  async #readBounded(target: string, maxBytes: number): Promise<string> {
    const stat = await lstat(target);
    if (!stat.isFile()) {
      throw new LedgerStoreError(`refusing non-regular control file: ${target}`);
    }
    if (stat.size > maxBytes) {
      throw new LedgerStoreError(`${target} exceeds bounded read limit (${stat.size} > ${maxBytes} bytes)`);
    }
    return readFile(target, "utf8");
  }
}

function assertMonotonic(events: readonly ImprovementRunEvent[], runId: string): void {
  let previous = 0;
  for (const event of events) {
    if (event.run_id !== runId) {
      throw new LedgerStoreError(`event run_id "${event.run_id}" does not match run "${runId}"`);
    }
    if (event.state_revision <= previous) {
      throw new LedgerStoreError(
        `event revisions not monotonic for run ${runId}: ${event.state_revision} after ${previous}`,
      );
    }
    previous = event.state_revision;
  }
}

function parseJson(raw: string, context: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new LedgerDecodeError(`${context}: malformed JSON`);
  }
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return isCode(error, "EPERM");
  }
}
