import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Serialize write/edit mutations that target the same real path.
 * Key is `fs.realpath` when the path exists; otherwise parent realpath + basename
 * (so create-write and follow-up edit on the same logical file share a queue).
 *
 * Different real paths may run concurrently. Abort does not clear the queue —
 * pending tasks still settle so callers get tool results instead of hanging.
 *
 * FIFO guarantee: run() claims its queue slot synchronously via an admission
 * chain, so enqueue order always equals call order. Resolving the key first
 * (realpath goes through the libuv thread pool) used to let a later caller
 * enqueue before an earlier one — measured ~16% reversal on same-path pairs.
 */
export class FileWriteQueue {
  readonly #tails = new Map<string, Promise<void>>();
  #admissionTail: Promise<void> = Promise.resolve();

  run<T>(filePath: string, task: () => Promise<T>): Promise<T> {
    // Key resolution starts immediately (parallel with any admission wait);
    // only the enqueue step is ordered by the admission chain.
    const keyPromise = resolveWriteQueueKey(filePath);
    const previousAdmission = this.#admissionTail;
    let admit!: () => void;
    this.#admissionTail = new Promise<void>((resolve) => {
      admit = resolve;
    });
    return previousAdmission
      .then(() => keyPromise)
      .then(
        (key) => {
          const result = this.#enqueue(key, task);
          // Slot claimed — release the next caller before this task settles so
          // different real paths still run concurrently.
          admit();
          return result;
        },
        (error: unknown) => {
          admit();
          throw error;
        },
      );
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
