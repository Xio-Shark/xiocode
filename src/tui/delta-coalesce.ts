/**
 * Coalesce soft stream deltas onto a frame cadence; hard events flush immediately.
 */

import type { TuiEvent } from "./session-bridge.ts";

export type CoalesceFlush = (events: readonly TuiEvent[]) => void;

const DEFAULT_FRAME_MS = 16;

export function isSoftDelta(event: TuiEvent): event is SoftDeltaEvent {
  return event.kind === "assistant-delta"
    || event.kind === "thinking-delta"
    || event.kind === "subagent-assistant-delta"
    || event.kind === "subagent-thinking-delta";
}

type SoftDeltaEvent = Extract<TuiEvent, {
  kind:
    | "assistant-delta"
    | "thinking-delta"
    | "subagent-assistant-delta"
    | "subagent-thinking-delta";
}>;

/**
 * Buffers assistant/thinking deltas and flushes on a timer or when a hard event
 * arrives. Hard events are always delivered immediately after any pending soft
 * flush (so tool boundaries see committed stream text).
 */
export function createDeltaCoalescer(
  flush: CoalesceFlush,
  options: Readonly<{ frameMs?: number; now?: () => number; schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clearSchedule?: (id: ReturnType<typeof setTimeout>) => void }> = {},
): Readonly<{
  push: (event: TuiEvent) => void;
  flushNow: () => void;
  dispose: () => void;
  pendingCount: () => number;
}> {
  const frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
  const schedule = options.schedule ?? setTimeout;
  const clearSchedule = options.clearSchedule ?? clearTimeout;
  let pending: TuiEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flushPending = () => {
    if (timer !== undefined) {
      clearSchedule(timer);
      timer = undefined;
    }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    flush(batch);
  };

  return {
    push(event: TuiEvent) {
      if (isSoftDelta(event)) {
        pending.push(event);
        if (timer === undefined) {
          timer = schedule(() => {
            timer = undefined;
            flushPending();
          }, frameMs);
        }
        return;
      }
      flushPending();
      flush([event]);
    },
    flushNow: flushPending,
    dispose() {
      flushPending();
    },
    pendingCount: () => pending.length,
  };
}

/** Merge consecutive same-kind soft deltas into one event (optional batch reduce). */
export function mergeSoftDeltas(events: readonly TuiEvent[]): readonly TuiEvent[] {
  if (events.length <= 1) return events;
  const out: TuiEvent[] = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (
      last
      && isSoftDelta(last)
      && isSoftDelta(event)
      && last.kind === event.kind
      && (!("workerId" in last) || !("workerId" in event) || last.workerId === event.workerId)
    ) {
      const merged = {
        ...last,
        text: last.text + event.text,
      } as SoftDeltaEvent;
      out[out.length - 1] = merged;
    } else {
      out.push(event);
    }
  }
  return out;
}
