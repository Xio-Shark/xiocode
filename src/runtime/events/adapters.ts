import type { SessionUiSink } from "../session-ui.ts";
import type { ChatToolCall, ToolExecuteResult } from "../types.ts";
import type { RuntimeEventEmitter, RuntimeEventV1 } from "./types.ts";

/**
 * Pipe RuntimeEvent stream into an existing SessionUiSink (human stdout / TUI bridge).
 * Keeps TuiEvent internal; does not replace SessionUiSink.
 */
export function pipeRuntimeEventsToSessionUi(
  bus: RuntimeEventEmitter,
  sink: SessionUiSink,
): () => void {
  return bus.subscribe((event) => {
    applyRuntimeEventToSessionUi(event, sink);
  });
}

export function applyRuntimeEventToSessionUi(
  event: RuntimeEventV1,
  sink: SessionUiSink,
): void {
  const payload = event.payload;
  switch (event.event) {
    case "text.delta": {
      const text = stringField(payload, "text");
      if (text !== undefined) sink.onAssistantDelta?.(text);
      break;
    }
    case "thinking.delta": {
      const text = stringField(payload, "text");
      if (text !== undefined) sink.onThinkingDelta?.(text);
      break;
    }
    case "tool.call": {
      const call = toolCallFromPayload(payload);
      if (call) sink.onToolStart?.(call);
      break;
    }
    case "tool.result":
    case "tool.error": {
      const call = toolCallFromPayload(payload);
      const result = toolResultFromPayload(payload, event.event === "tool.error");
      if (call && result) sink.onToolEnd?.(call, result);
      break;
    }
    case "cancel": {
      sink.onCancelled?.();
      break;
    }
    case "error": {
      const message = stringField(payload, "message") ?? "error";
      sink.notify?.(message, "error");
      break;
    }
    default:
      break;
  }
}

/**
 * Trajectory / run-evidence consumer. Maps RuntimeEvent → recorder methods.
 * Callers pass a duck-typed recorder so evolve stays a soft dependency.
 */
export type TrajectoryEventSink = Readonly<{
  recordToolCall?: (event: unknown) => void | Promise<void>;
  recordToolResult?: (event: unknown) => void | Promise<void>;
  recordTurnEnd?: (event: unknown) => void | Promise<void>;
  recordProviderUsage?: (event: unknown) => void;
}>;

export function pipeRuntimeEventsToTrajectory(
  bus: RuntimeEventEmitter,
  recorder: TrajectoryEventSink,
): () => void {
  return bus.subscribe((event) => {
    void applyRuntimeEventToTrajectory(event, recorder);
  });
}

export async function applyRuntimeEventToTrajectory(
  event: RuntimeEventV1,
  recorder: TrajectoryEventSink,
): Promise<void> {
  switch (event.event) {
    case "tool.call":
      await recorder.recordToolCall?.(event.payload);
      break;
    case "tool.result":
    case "tool.error":
      await recorder.recordToolResult?.(event.payload);
      break;
    case "turn.end":
      await recorder.recordTurnEnd?.(event.payload);
      break;
    case "provider.done":
      if (event.payload.usage !== undefined) {
        recorder.recordProviderUsage?.({ usage: event.payload.usage });
      }
      break;
    default:
      break;
  }
}

function stringField(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function toolCallFromPayload(payload: Readonly<Record<string, unknown>>): ChatToolCall | undefined {
  const nested = asRecord(payload.call);
  const id = stringField(payload, "toolCallId")
    ?? stringField(payload, "id")
    ?? (nested ? stringField(nested, "id") : undefined)
    ?? "unknown";
  const name = stringField(payload, "toolName")
    ?? stringField(payload, "name")
    ?? (nested ? stringField(nested, "name") : undefined);
  if (!name) return undefined;
  const args = asRecord(payload.args)
    ?? asRecord(payload.input)
    ?? (nested ? asRecord(nested.args) ?? asRecord(nested.input) : undefined)
    ?? {};
  return { id, name, arguments: args };
}

function toolResultFromPayload(
  payload: Readonly<Record<string, unknown>>,
  forceError: boolean,
): ToolExecuteResult | undefined {
  const nested = asRecord(payload.result);
  const isError = forceError
    || payload.isError === true
    || nested?.isError === true;
  if (typeof payload.content === "string") {
    return {
      content: [{ type: "text", text: payload.content }],
      isError,
    };
  }
  if (nested && Array.isArray(nested.content)) {
    return {
      content: nested.content as ToolExecuteResult["content"],
      isError,
    };
  }
  if (typeof nested?.content === "string") {
    return {
      content: [{ type: "text", text: nested.content }],
      isError,
    };
  }
  const text = stringField(payload, "text") ?? "";
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
