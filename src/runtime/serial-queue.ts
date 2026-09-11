/**
 * FIFO serialization by explicit opaque key.
 *
 * Unlike {@link FileWriteQueue} the key is used verbatim (no realpath), so
 * non-file resource families — e.g. one MCP browser server — can share a single
 * queue slot and run one action at a time in enqueue order.
 *
 * FIFO guarantee: the slot is claimed synchronously, so enqueue order equals
 * execution order. Abort does not clear the queue; pending tasks still settle so
 * callers get tool results instead of hanging.
 */
export class SerialQueue {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
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
