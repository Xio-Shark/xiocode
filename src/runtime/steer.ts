import { randomUUID } from "node:crypto";

export type SteerMode = "hard" | "soft" | "auto";

export type SteerRequest = Readonly<{
  id: string;
  mode: "hard" | "soft";
  text: string;
  requestedAt: string;
}>;

export type FollowUpRequest = Readonly<{
  id: string;
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

export type EnqueueFollowUpInput = Readonly<{
  text: string;
  now?: () => Date;
}>;

/**
 * Dual queues for mid-run adjustment (steer) and post-run continuation (follow-up).
 *
 * - Soft/hard steer: turn / tool-batch boundaries (never mid-stream provider inject).
 * - Follow-up: only when the loop would otherwise end (no tool calls + soft empty).
 *
 * **Invariant:** never inject into an in-flight provider HTTP body.
 */
export class SteerMailbox {
  private readonly pending: SteerRequest[] = [];
  private readonly followUps: FollowUpRequest[] = [];

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

  enqueueFollowUp(input: EnqueueFollowUpInput): FollowUpRequest {
    const text = input.text.trim();
    if (text.length === 0) {
      throw new Error("follow-up text must be non-empty");
    }
    const request: FollowUpRequest = {
      id: randomUUID().replaceAll("-", "").slice(0, 12),
      text,
      requestedAt: (input.now ?? (() => new Date()))().toISOString(),
    };
    this.followUps.push(request);
    return request;
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  hasHard(): boolean {
    return this.pending.some((item) => item.mode === "hard");
  }

  hasFollowUp(): boolean {
    return this.followUps.length > 0;
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

  /**
   * Take one follow-up (FIFO). Caller must only invoke at natural-end boundary
   * (no tool calls remaining and soft steer queue empty).
   */
  takeFollowUp(): FollowUpRequest | undefined {
    return this.followUps.shift();
  }

  /** Snapshot of pending follow-ups (tests / UI). */
  listFollowUp(): readonly FollowUpRequest[] {
    return this.followUps.slice();
  }

  /**
   * Clear follow-ups (abort path). Returns discarded items for events/UI notice.
   * Does not touch soft/hard steer entries.
   */
  clearFollowUp(): FollowUpRequest[] {
    const discarded = this.followUps.splice(0, this.followUps.length);
    return discarded;
  }

  /** Snapshot for tests (steer only). */
  list(): readonly SteerRequest[] {
    return this.pending.slice();
  }

  /** Clear steer + follow-up queues. */
  clear(): void {
    this.pending.length = 0;
    this.followUps.length = 0;
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

/**
 * Follow-up is ordinary subsequent user work in the same session run
 * (tutorial-aligned), not a steer tag.
 */
export function formatFollowUpUserMessage(text: string): string {
  return text;
}
