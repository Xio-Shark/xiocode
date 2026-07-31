import { resolveWriteQueueKey } from "./file-write-queue.ts";

/**
 * Detects "the code under your feet moved": a file that one context has read is then
 * written by a **different** concurrent context in the same session (e.g. a read-only
 * explore worker read file X, then the main agent overwrote X).
 *
 * jcode-parity note: this only *reports* (`workspace.file_shifted`). It never auto-spawns
 * a fixer, never auto-reverts, and never resolves the conflict silently — surfacing the
 * staleness to the owning context is the whole contract.
 *
 * Keyed by realpath so symlinks / relative-vs-absolute paths collapse to one file.
 */
export type FileShiftInfo = Readonly<{
  /** The file path passed to the write (as the caller referenced it). */
  path: string;
  /** Context id that performed the write. */
  writer: string;
  /** Other context ids whose earlier read of this path just went stale. */
  readers: readonly string[];
}>;

export class FileShiftRegistry {
  /** realpath key → context ids that have read the path. */
  readonly #readers = new Map<string, Set<string>>();
  /** realpath key → writer context ids already notified (dedup, avoid re-spamming). */
  readonly #notified = new Map<string, Set<string>>();

  /** Record that `contextId` observed (read) `filePath`. */
  async markRead(contextId: string, filePath: string): Promise<void> {
    const key = await resolveWriteQueueKey(filePath);
    const set = this.#readers.get(key) ?? new Set<string>();
    set.add(contextId);
    this.#readers.set(key, set);
  }

  /**
   * Record a successful write by `contextId` to `filePath`.
   *
   * @returns the other context ids that had already read this path (whose view is now
   * stale). Empty when no other context read it. De-duplicated per (path, writer): a
   * second write to the same path by the same writer returns `[]` so we do not re-notify.
   * The writer is then registered as a reader (the write establishes its own baseline).
   */
  async noteWrite(contextId: string, filePath: string): Promise<readonly string[]> {
    const key = await resolveWriteQueueKey(filePath);
    const readers = this.#readers.get(key);
    const others = readers ? [...readers].filter((id) => id !== contextId) : [];
    // The writer now owns the current bytes for later staleness checks.
    const readerSet = readers ?? new Set<string>();
    readerSet.add(contextId);
    this.#readers.set(key, readerSet);
    if (others.length === 0) {
      return [];
    }
    const notified = this.#notified.get(key) ?? new Set<string>();
    if (notified.has(contextId)) {
      return [];
    }
    notified.add(contextId);
    this.#notified.set(key, notified);
    return others;
  }

  clear(): void {
    this.#readers.clear();
    this.#notified.clear();
  }
}
