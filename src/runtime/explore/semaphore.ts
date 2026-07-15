/** Simple async concurrency gate for parallel explore subagents. */
export class Semaphore {
  #active = 0;
  readonly #fixedMax: number | undefined;
  readonly #getMax: (() => number) | undefined;
  readonly #waiters: Array<() => void> = [];

  constructor(max: number | (() => number)) {
    if (typeof max === "function") {
      this.#getMax = max;
      this.#fixedMax = undefined;
      return;
    }
    if (!Number.isInteger(max) || max < 1) {
      throw new Error("Semaphore max must be a positive integer");
    }
    this.#fixedMax = max;
    this.#getMax = undefined;
  }

  /** Current limit (dynamic getters may change between acquires). */
  limit(): number {
    if (this.#getMax) {
      const value = Math.floor(this.#getMax());
      return Number.isFinite(value) && value >= 1 ? value : 1;
    }
    return this.#fixedMax ?? 1;
  }

  async acquire(): Promise<() => void> {
    while (this.#active >= this.limit()) {
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
      });
      // Re-check limit after wake (may have dropped when thinking left ultra).
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
