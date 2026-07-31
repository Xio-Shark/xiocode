import { redactRuntimePayload } from "./redact.ts";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEventEmitter,
  type RuntimeEventHandler,
  type RuntimeEventIds,
  type RuntimeEventName,
  type RuntimeEventV1,
} from "./types.ts";

export type SubscriberErrorReport = Readonly<{
  event: RuntimeEventName;
  seq: number;
  phase: "sync" | "async";
  error: unknown;
}>;

export type CreateRuntimeEventEmitterOptions = Readonly<{
  sessionId: string;
  runId: string;
  turnId?: string | null;
  now?: () => Date;
  /** When false, skip redaction (tests only). Default true. */
  redact?: boolean;
  /**
   * Diagnostic sink for subscriber failures. Failures are isolated from the
   * agent loop but must stay observable (R6.4) — default reports to stderr.
   */
  onSubscriberError?: (report: SubscriberErrorReport) => void;
}>;

/** Cap default stderr reports per emitter so a hot subscriber cannot flood logs. */
const MAX_DEFAULT_ERROR_REPORTS = 20;

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
  const pending = new Set<Promise<unknown>>();
  let defaultReports = 0;
  const reportSubscriberError = (report: SubscriberErrorReport): void => {
    try {
      if (options.onSubscriberError) {
        options.onSubscriberError(report);
        return;
      }
      if (defaultReports >= MAX_DEFAULT_ERROR_REPORTS) return;
      defaultReports += 1;
      const message = report.error instanceof Error ? report.error.message : String(report.error);
      const suffix = defaultReports === MAX_DEFAULT_ERROR_REPORTS ? " (further reports suppressed)" : "";
      process.stderr.write(
        `runtime-event subscriber failed (${report.phase}) on ${report.event} seq=${report.seq}: ${message}${suffix}\n`,
      );
    } catch {
      // The diagnostic path itself must never break the agent loop.
    }
  };

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
            const tracked = Promise.resolve(result as Promise<void>).then(
              () => undefined,
              (error) => {
                reportSubscriberError({ event, seq: envelope.seq, phase: "async", error });
                return undefined;
              },
            );
            pending.add(tracked);
            void tracked.finally(() => {
              pending.delete(tracked);
            });
          }
        } catch (error) {
          // Subscriber failures must not break the agent loop, but stay observable.
          reportSubscriberError({ event, seq: envelope.seq, phase: "sync", error });
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
    async flushPending() {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
  };
}
