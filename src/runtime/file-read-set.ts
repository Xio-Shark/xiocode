import { resolveWriteQueueKey } from "./file-write-queue.ts";

/**
 * Tracks paths successfully observed via `read` (and successful write/edit)
 * within a session run.
 *
 * Policy:
 * - Kept across abort / hard-steer hops inside the same `runPrompt`.
 * - Cleared on each new user turn (`beforePrompt`) so a fresh prompt does not
 *   inherit stale "already read" state from a prior task.
 */
export class FileReadSet {
  readonly #keys = new Set<string>();

  async mark(filePath: string): Promise<void> {
    this.#keys.add(await resolveWriteQueueKey(filePath));
  }

  async has(filePath: string): Promise<boolean> {
    return this.#keys.has(await resolveWriteQueueKey(filePath));
  }

  clear(): void {
    this.#keys.clear();
  }

  get size(): number {
    return this.#keys.size;
  }
}
