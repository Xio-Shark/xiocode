import type { RuntimeEventV1 } from "../../events/types.ts";

/**
 * Normalize RuntimeEvent stream for golden JSONL comparison.
 * Strips volatile fields (timestamp) and keeps order + event names + stable payload keys.
 */
export function normalizeRuntimeEventsForGolden(
  events: readonly RuntimeEventV1[],
): readonly Record<string, unknown>[] {
  return events.map((event) => ({
    schema_version: event.schema_version,
    seq: event.seq,
    session_id: event.session_id,
    run_id: event.run_id,
    turn_id: event.turn_id,
    event: event.event,
    payload: stabilizePayload(event.payload),
  }));
}

export function runtimeEventNames(events: readonly RuntimeEventV1[]): readonly string[] {
  return events.map((event) => event.event);
}

function stabilizePayload(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    // snapshot_id is allocated per request and is not golden-stable
    if (key === "snapshot_id") continue;
    out[key] = payload[key];
  }
  return out;
}
