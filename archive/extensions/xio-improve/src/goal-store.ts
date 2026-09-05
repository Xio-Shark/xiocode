import { BUILTIN_SEEDS } from "./seeds.ts";

import type { GoalSource, ImproveGoal } from "./types.ts";

/**
 * T4 GoalStore: queue → red_test → seed.
 * `external_eval` goals are enqueued into the queue bucket via {@link enqueue}.
 */
export class GoalStore {
  readonly #queue: ImproveGoal[] = [];
  readonly #redTests: ImproveGoal[] = [];
  readonly #seeds: ImproveGoal[] = [];

  constructor(options: { loadBuiltinSeeds?: boolean } = {}) {
    if (options.loadBuiltinSeeds !== false) {
      for (const seed of BUILTIN_SEEDS) {
        this.#seeds.push(seed);
      }
    }
  }

  enqueue(goal: ImproveGoal): void {
    this.#queue.push(withSource(goal, goal.source === "external_eval" ? "external_eval" : "queue"));
  }

  addRedTest(goal: ImproveGoal): void {
    this.#redTests.push(withSource(goal, "red_test"));
  }

  addSeed(goal: ImproveGoal): void {
    this.#seeds.push(withSource(goal, "seed"));
  }

  /** T4: first non-empty bucket wins — queue, then red_test, then seed. */
  next(): ImproveGoal | undefined {
    if (this.#queue.length > 0) {
      return this.#queue.shift();
    }
    if (this.#redTests.length > 0) {
      return this.#redTests.shift();
    }
    if (this.#seeds.length > 0) {
      return this.#seeds.shift();
    }
    return undefined;
  }

  peek(): ImproveGoal | undefined {
    return this.#queue[0] ?? this.#redTests[0] ?? this.#seeds[0];
  }

  /** Next source that would be drained (for tests / status). */
  peekSource(): GoalSource | undefined {
    if (this.#queue.length > 0) {
      return this.#queue[0]?.source === "external_eval" ? "external_eval" : "queue";
    }
    if (this.#redTests.length > 0) {
      return "red_test";
    }
    if (this.#seeds.length > 0) {
      return "seed";
    }
    return undefined;
  }

  sizes(): Readonly<{ queue: number; redTest: number; seed: number }> {
    return {
      queue: this.#queue.length,
      redTest: this.#redTests.length,
      seed: this.#seeds.length,
    };
  }

  isEmpty(): boolean {
    return this.#queue.length === 0 && this.#redTests.length === 0 && this.#seeds.length === 0;
  }
}

function withSource(goal: ImproveGoal, source: GoalSource): ImproveGoal {
  return { ...goal, source };
}
