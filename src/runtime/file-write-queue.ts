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
  readonly #resolveKey: (filePath: string) => Promise<string>;
  #admissionTail: Promise<void> = Promise.resolve();

  constructor(resolveKey: (filePath: string) => Promise<string> = resolveWriteQueueKey) {
    this.#resolveKey = resolveKey;
  }

  run<T>(filePath: string, task: () => Promise<T>): Promise<T> {
    const keyPromise = Promise.resolve().then(() => this.#resolveKey(filePath));
    // Reserve admission synchronously, but only serialize key registration.
    // The per-key tail below still lets mutations for different files overlap.
    const admission = this.#admissionTail.then(async () => {
      const key = await keyPromise;
      return { result: this.#enqueue(key, task) };
    });
    this.#admissionTail = admission.then(
      () => undefined,
      () => undefined,
    );
    return admission.then(({ result }) => result);
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
