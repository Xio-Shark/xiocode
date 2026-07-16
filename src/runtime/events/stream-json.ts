import type { SessionUiSink } from "../session-ui.ts";
import type { RuntimeEventEmitter, RuntimeEventV1 } from "./types.ts";

/**
 * Write one RuntimeEvent.v1 JSON object per line (NDJSON). Flush each line for CI tailing.
 */
export function writeRuntimeEventNdjson(
  event: RuntimeEventV1,
  write: (chunk: string) => void,
): void {
  write(`${JSON.stringify(event)}\n`);
}

/** Subscribe bus → stdout NDJSON. Returns unsubscribe. */
export function pipeRuntimeEventsToStreamJson(
  bus: RuntimeEventEmitter,
  write: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk);
  },
): () => void {
  return bus.subscribe((event) => {
    writeRuntimeEventNdjson(event, write);
  });
}

/**
 * SessionUiSink that never writes protocol traffic to stdout.
 * Optional diagnostics go to stderr (or provided write).
 */
export function createStreamJsonSessionUiSink(
  stderrWrite: (chunk: string) => void = (chunk) => {
    process.stderr.write(chunk);
  },
): SessionUiSink {
  return {
    notify(message, level) {
      stderrWrite(`${level ? `[${level}] ` : ""}${message}\n`);
    },
    setStatus() {
      // status is human chrome — keep off stdout in stream-json mode
    },
    setWidget() {
      // widgets are human chrome
    },
    // Assistant/tool streams are delivered as RuntimeEvents, not UI callbacks.
  };
}

export function parseNdjsonRuntimeEvents(stdout: string): RuntimeEventV1[] {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `stream-json line ${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`stream-json line ${index + 1} is not an object`);
    }
    const record = parsed as Record<string, unknown>;
    if (record.schema_version !== "xio-runtime-event.v1") {
      throw new Error(
        `stream-json line ${index + 1} missing schema_version xio-runtime-event.v1`,
      );
    }
    return parsed as RuntimeEventV1;
  });
}
