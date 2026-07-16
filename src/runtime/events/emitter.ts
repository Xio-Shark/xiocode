import { redactRuntimePayload } from "./redact.ts";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEventEmitter,
  type RuntimeEventHandler,
  type RuntimeEventIds,
  type RuntimeEventName,
  type RuntimeEventV1,
} from "./types.ts";

export type CreateRuntimeEventEmitterOptions = Readonly<{
  sessionId: string;
  runId: string;
  turnId?: string | null;
  now?: () => Date;
  /** When false, skip redaction (tests only). Default true. */
  redact?: boolean;
}>;

/**
 * Per-run event bus. Seq is monotonic for this emitter instance (one run_id).
 * Not a process-global singleton — create per session/run and pass into the loop.
 */
export function createRuntimeEventEmitter(
  options: CreateRuntimeEventEmitterOptions,
): RuntimeEventEmitter {
  let seq = 0;
  let turnId: string | null = options.turnId ?? null;
  const sessionId = options.sessionId;
  const runId = options.runId;
  const now = options.now ?? (() => new Date());
  const shouldRedact = options.redact !== false;
  const handlers = new Set<RuntimeEventHandler>();

  return {
    emit(event: RuntimeEventName, payload: Readonly<Record<string, unknown>> = {}, ids?) {
      const body = shouldRedact
        ? redactRuntimePayload({ ...payload })
        : { ...payload };
      const envelope: RuntimeEventV1 = {
        schema_version: RUNTIME_EVENT_SCHEMA_VERSION,
        seq: seq++,
        timestamp: now().toISOString(),
        session_id: ids?.session_id ?? sessionId,
        run_id: ids?.run_id ?? runId,
        turn_id: ids?.turn_id !== undefined ? (ids.turn_id ?? null) : turnId,
        event,
        payload: body,
      };
      for (const handler of handlers) {
        try {
          const result = handler(envelope);
          if (result && typeof (result as Promise<void>).then === "function") {
            void (result as Promise<void>).catch(() => undefined);
          }
        } catch {
          // Subscriber failures must not break the agent loop.
        }
      }
      return envelope;
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    getIds(): RuntimeEventIds & { turn_id: string | null } {
      return { session_id: sessionId, run_id: runId, turn_id: turnId };
    },
    setTurnId(next) {
      turnId = next;
    },
    peekSeq() {
      return seq;
    },
  };
}
