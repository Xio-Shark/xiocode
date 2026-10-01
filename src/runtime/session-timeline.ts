/**
 * When things happened in a session: the start and end of every turn, provider
 * call and tool call, plus provider token usage. Messages carry no timestamps,
 * so this side file (`timeline.jsonl` next to state.json) is what turns a
 * transcript into a real time axis and keeps usage across reloads.
 *
 * It is written from the RuntimeEvent bus, not from the WAL: the WAL is for
 * recovery and must not grow with telemetry. Records are only appended once the
 * session has saved state; until then they wait in memory.
 */

import { createHash } from "node:crypto";

import type { RuntimeEventHandler, RuntimeEventV1 } from "./events/types.ts";
import type { TokenUsage } from "./types.ts";

export const TIMELINE_FILE = "timeline.jsonl";

const TIMELINE_EVENTS = new Set<string>([
  "turn.start",
  "turn.end",
  "provider.request",
  "provider.done",
  "tool.call",
  "tool.result",
  "tool.error",
]);

export type TimelineRecord = Readonly<{
  at: string;
  event: string;
  run: string;
  seq: number;
  /** turn.start: hash of the prompt, matched against the stored user message (the text itself is not copied). */
  promptHash?: string;
  /** tool.*: the call this record belongs to. */
  toolCallId?: string;
  /** provider.done: token usage reported by the provider. */
  usage?: TokenUsage;
  /** turn.end: success / error / cancelled. */
  outcome?: string;
}>;

export function hashPrompt(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function toTimelineRecord(event: RuntimeEventV1): TimelineRecord | undefined {
  if (!TIMELINE_EVENTS.has(event.event)) return undefined;
  const p = event.payload;
  return {
    at: event.timestamp,
    event: event.event,
    run: event.run_id,
    seq: event.seq,
    ...(event.event === "turn.start" && typeof p.prompt === "string" ? { promptHash: hashPrompt(p.prompt) } : {}),
    ...(typeof p.toolCallId === "string" ? { toolCallId: p.toolCallId } : {}),
    ...(event.event === "provider.done" && isRecord(p.usage) ? { usage: p.usage as TokenUsage } : {}),
    ...(event.event === "turn.end" && typeof p.outcome === "string" ? { outcome: p.outcome } : {}),
  };
}

export type TimelineSink = Readonly<{
  /** Append records; false (nothing written) while the session is not saved yet. */
  appendSideRecords: (id: string, file: string, records: readonly unknown[]) => Promise<boolean>;
}>;

/**
 * Subscriber for the session's event bus. Writes are serialized so the file keeps
 * event order; a failed write rejects the handler, which the bus reports as a notice.
 */
export function createTimelineRecorder(store: TimelineSink, sessionId: string): RuntimeEventHandler {
  const buffer: TimelineRecord[] = [];
  let writing: Promise<void> = Promise.resolve();

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const batch = buffer.slice();
    if (await store.appendSideRecords(sessionId, TIMELINE_FILE, batch)) buffer.splice(0, batch.length);
  };

  return (event) => {
    const record = toTimelineRecord(event);
    if (record) buffer.push(record);
    // Messages were just persisted: the session file exists from here on.
    if (!record && event.event !== "harness.save_point") return;
    // A failed write was already reported through the previous handler; retry with this event.
    writing = writing.catch(() => undefined).then(flush);
    return writing;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
