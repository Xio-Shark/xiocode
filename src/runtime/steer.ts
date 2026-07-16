import { randomUUID } from "node:crypto";

export type SteerMode = "hard" | "soft" | "auto";

export type SteerRequest = Readonly<{
  id: string;
  mode: "hard" | "soft";
  text: string;
  requestedAt: string;
}>;

export type EnqueueSteerInput = Readonly<{
  text: string;
  mode?: SteerMode;
  /**
   * When mode is `auto`: hard if turn is busy (caller passes true), else soft.
   * Default soft when busy is unknown.
   */
  busy?: boolean;
  now?: () => Date;
}>;

/**
 * Thread-safe enough for single-threaded JS event loop.
 * Hard steers abort; soft steers wait for tool/provider boundaries.
 *
 * **Invariant:** never inject into an in-flight provider HTTP body.
 */
export class SteerMailbox {
  private readonly pending: SteerRequest[] = [];

  enqueue(input: EnqueueSteerInput): SteerRequest {
    const text = input.text.trim();
    if (text.length === 0) {
      throw new Error("steer text must be non-empty");
    }
    const resolved = resolveSteerMode(input.mode ?? "auto", input.busy === true);
    const request: SteerRequest = {
      id: randomUUID().replaceAll("-", "").slice(0, 12),
      mode: resolved,
      text,
      requestedAt: (input.now ?? (() => new Date()))().toISOString(),
    };
    this.pending.push(request);
    return request;
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  hasHard(): boolean {
    return this.pending.some((item) => item.mode === "hard");
  }

  /** Drain all soft requests (FIFO). Leaves hard requests in queue. */
  drainSoft(): SteerRequest[] {
    const soft: SteerRequest[] = [];
    const rest: SteerRequest[] = [];
    for (const item of this.pending) {
      if (item.mode === "soft") soft.push(item);
      else rest.push(item);
    }
    this.pending.length = 0;
    this.pending.push(...rest);
    return soft;
  }

  /** Take the first hard request, if any. */
  takeHard(): SteerRequest | undefined {
    const index = this.pending.findIndex((item) => item.mode === "hard");
    if (index < 0) return undefined;
    const [item] = this.pending.splice(index, 1);
    return item;
  }

  /** Snapshot for tests. */
  list(): readonly SteerRequest[] {
    return this.pending.slice();
  }

  clear(): void {
    this.pending.length = 0;
  }
}

export function resolveSteerMode(mode: SteerMode, busy: boolean): "hard" | "soft" {
  if (mode === "hard" || mode === "soft") return mode;
  return busy ? "hard" : "soft";
}

/** User-visible steer injection (not claimed as mid-stream provider inject). */
export function formatSteerUserMessage(text: string, mode: "hard" | "soft"): string {
  return `[steer:${mode}] ${text}`;
}
