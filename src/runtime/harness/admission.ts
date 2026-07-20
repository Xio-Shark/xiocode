import type { RuntimeEventEmitter } from "../events/types.ts";

/** Harness phase (maps over session execution.phase; coarser for admission). */
export type HarnessPhase = "idle" | "turn" | "compaction" | "retry";

/** Structural ops that require idle (or throw SessionBusyError). */
export type StructuralOp = "prompt" | "compaction";

export class SessionBusyError extends Error {
  readonly code = "session_busy" as const;
  readonly phase: HarnessPhase;
  readonly op: StructuralOp;

  constructor(phase: HarnessPhase, op: StructuralOp) {
    super(`session busy (${phase}): refused structural ${op}`);
    this.name = "SessionBusyError";
    this.phase = phase;
    this.op = op;
  }
}

export function isSessionBusyError(error: unknown): error is SessionBusyError {
  return error instanceof SessionBusyError
    || (Boolean(error)
      && typeof error === "object"
      && (error as { code?: unknown }).code === "session_busy");
}

export type HarnessControllerOptions = Readonly<{
  runtimeEvents?: RuntimeEventEmitter;
  /**
   * When true (default), emit harness.phase / harness.save_point / harness.settled
   * on the shared RuntimeEvent bus.
   */
  emitEvents?: boolean;
}>;

/**
 * Session-boundary admission + settle tracking.
 *
 * Rules (tutorial §15):
 * - Structural ops (prompt, compaction) check+switch phase before first await.
 * - Soft steer stays queue-based (not admitted here).
 * - waitForIdle drains tracked listener/persist work and does not return early.
 */
export class HarnessController {
  #phase: HarnessPhase = "idle";
  readonly #pending = new Set<Promise<unknown>>();
  readonly #idleWaiters: Array<() => void> = [];
  readonly #events: RuntimeEventEmitter | undefined;
  readonly #emitEvents: boolean;

  constructor(options: HarnessControllerOptions = {}) {
    this.#events = options.runtimeEvents;
    this.#emitEvents = options.emitEvents !== false;
  }

  get phase(): HarnessPhase {
    return this.#phase;
  }

  isBusy(): boolean {
    return this.#phase !== "idle";
  }

  /**
   * Admit a structural operation. MUST run before the first await of that op.
   * Throws SessionBusyError when not idle.
   */
  begin(op: StructuralOp): void {
    if (this.#phase !== "idle") {
      throw new SessionBusyError(this.#phase, op);
    }
    this.#phase = op === "compaction" ? "compaction" : "turn";
    this.#emit("harness.phase", { phase: this.#phase, op });
  }

  /**
   * Track async work that must finish before waitForIdle / settle returns
   * (listener writes, extra journal appends, etc.).
   */
  trackSettle(work: Promise<unknown>): void {
    const tracked = Promise.resolve(work).then(
      () => undefined,
      () => undefined,
    );
    this.#pending.add(tracked);
    void tracked.finally(() => {
      this.#pending.delete(tracked);
      if (this.#phase === "idle" && this.#pending.size === 0) {
        this.#notifyIdle();
      }
    });
  }

  /** Record a save-point after messages were persisted. */
  noteSavePoint(payload: Readonly<Record<string, unknown>> = {}): void {
    this.#emit("harness.save_point", { ...payload });
  }

  /**
   * End the structural op: flush pending settles, return to idle, emit settled.
   * Safe to call multiple times (no-op when already idle with nothing pending).
   */
  async end(): Promise<void> {
    await this.#flushPending();
    if (this.#phase !== "idle") {
      this.#phase = "idle";
      this.#emit("harness.phase", { phase: "idle" });
    }
    this.#emit("harness.settled", {});
    await this.#flushPending();
    this.#notifyIdle();
  }

  /**
   * Wait until phase is idle and all tracked settle work has finished.
   * Does not return while listeners attached via trackSettle are still running.
   */
  async waitForIdle(): Promise<void> {
    for (;;) {
      await this.#flushPending();
      if (this.#phase === "idle" && this.#pending.size === 0) {
        return;
      }
      if (this.#phase !== "idle") {
        await new Promise<void>((resolve) => {
          this.#idleWaiters.push(resolve);
        });
        continue;
      }
      // phase idle but pending arrived mid-flush — loop again
    }
  }

  async #flushPending(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
    // Also drain event-bus async handlers when available.
    const flush = this.#events?.flushPending;
    if (typeof flush === "function") {
      await flush.call(this.#events);
    }
  }

  #notifyIdle(): void {
    if (this.#phase !== "idle" || this.#pending.size > 0) return;
    const waiters = this.#idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  #emit(event: "harness.phase" | "harness.save_point" | "harness.settled", payload: Record<string, unknown>): void {
    if (!this.#emitEvents || !this.#events) return;
    this.#events.emit(event, payload);
  }
}
