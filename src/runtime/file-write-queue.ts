import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Serialize write/edit mutations that target the same real path.
 * Key is `fs.realpath` when the path exists; otherwise parent realpath + basename
 * (so create-write and follow-up edit on the same logical file share a queue).
 *
 * Different real paths may run concurrently. Abort does not clear the queue —
 * pending tasks still settle so callers get tool results instead of hanging.
 */
export class FileWriteQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(filePath: string, task: () => Promise<T>): Promise<T> {
    const key = await resolveWriteQueueKey(filePath);
    // Enqueue synchronously after key resolution so two concurrent run() calls
    // cannot both observe an empty tail for the same key.
    return this.#enqueue(key, task);
  }

  #enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    this.#tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}

/** Exported for tests and read-set key alignment. */
export async function resolveWriteQueueKey(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  try {
    return await realpath(resolved);
  } catch {
    try {
      const parent = await realpath(path.dirname(resolved));
      return path.join(parent, path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}
