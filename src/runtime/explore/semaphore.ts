/** Simple async concurrency gate for parallel explore subagents. */
export class Semaphore {
  #active = 0;
  readonly #max: number;
  readonly #waiters: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error("Semaphore max must be a positive integer");
    }
    this.#max = max;
  }

  async acquire(): Promise<() => void> {
    if (this.#active >= this.#max) {
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
      });
    }
    this.#active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#active -= 1;
      const next = this.#waiters.shift();
      next?.();
    };
  }
}
