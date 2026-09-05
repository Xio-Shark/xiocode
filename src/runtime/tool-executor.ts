import type { ExtensionHost } from "./extension-host.ts";
import type {
  ChatMessage,
  ChatToolCall,
  ToolCallEvent,
  ToolDefinition,
  ToolExecuteResult,
} from "./types.ts";
import type { AgentLoopCheckpoint, AgentLoopOptions, TurnToolCollector } from "./agent-loop-types.ts";
import type { RuntimeEventEmitter } from "./events/types.ts";

export type RepeatToolGuard = Readonly<{
  consume: (call: ChatToolCall) => string | undefined;
}>;

export function createRepeatToolGuard(limit: number): RepeatToolGuard {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { consume: () => undefined };
  }
  const max = Math.floor(limit);
  let lastKey: string | undefined;
  let count = 0;
  return {
    consume(call) {
      const key = toolCallFingerprint(call);
      if (key === lastKey) {
        count += 1;
      } else {
        lastKey = key;
        count = 1;
      }
      if (count <= max) return undefined;
      return [
        `repeated tool blocked: ${call.name} identical args called ${count} times in a row (limit ${max}).`,
        "Change arguments, use a different tool, or answer the user without re-running the same call.",
      ].join(" ");
    },
  };
}

/** Exported for unit tests and loop guards. */
export function toolCallFingerprint(call: Readonly<{ name: string; arguments: Record<string, unknown> }>): string {
  return `${call.name}\0${stableJson(call.arguments)}`;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function blockedToolCallResult(reason: string): ToolExecuteResult {
  return {
    content: [{ type: "text", text: reason }],
    isError: true,
  };
}

export function appendToolResult(messages: ChatMessage[], call: ChatToolCall, result: ToolExecuteResult): void {
  messages.push({
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: result.content.map((part) => part.text).join("\n"),
  });
}

export function interruptedToolResult(call: ChatToolCall): ToolExecuteResult {
  return {
    content: [{
      type: "text",
      text: `tool interrupted: completion unknown for ${call.name}; inspect workspace state before retrying`,
    }],
    isError: true,
  };
}

/** Cap stored tool body in turn_end payload (full body still lives in session messages / tool_result hooks). */
const TURN_END_TOOL_CONTENT_MAX = 4_000;

export function recordTurnToolResult(
  collector: TurnToolCollector,
  call: ChatToolCall,
  result: ToolExecuteResult,
  bus?: RuntimeEventEmitter,
): void {
  const raw = toolContentText(result.content);
  const content = raw.length > TURN_END_TOOL_CONTENT_MAX
    ? `${raw.slice(0, TURN_END_TOOL_CONTENT_MAX)}…[truncated]`
    : raw;
  collector.results.push({
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError: result.isError === true,
  });
  const isError = result.isError === true;
  bus?.emit(isError ? "tool.error" : "tool.result", {
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError,
  });
}

export async function appendInterruptedResults(
  messages: ChatMessage[],
  options: AgentLoopOptions,
  calls: readonly ChatToolCall[],
  toolCollector: TurnToolCollector,
): Promise<void> {
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]!;
    const result = interruptedToolResult(call);
    appendToolResult(messages, call, result);
    recordTurnToolResult(toolCollector, call, result, options.runtimeEvents);
    await publishCheckpoint(options, {
      phase: "tool_batch_running",
      messages,
      pendingTools: calls.slice(index + 1).map(({ id, name }) => ({ id, name })),
    });
  }
}

export async function publishCheckpoint(
  options: AgentLoopOptions,
  checkpoint: AgentLoopCheckpoint,
): Promise<void> {
  await options.onCheckpoint?.({
    ...checkpoint,
    messages: checkpoint.messages.map((message) => ({
      ...message,
      ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call, arguments: { ...call.arguments } })) } : {}),
    })),
  });
}

export async function executeToolCall(
  host: ExtensionHost,
  call: ChatToolCall,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  if (signal?.aborted) {
    return {
      content: [{ type: "text", text: "tool cancelled: AbortSignal aborted before start" }],
      isError: true,
    };
  }
  if (call.argumentError) {
    return emitToolResult(host, call, {
      content: [{ type: "text", text: `tool arguments rejected: ${call.argumentError}` }],
      isError: true,
    }, signal);
  }
  const tool = host.getTool(call.name);
  const args = tool ? stripUnknownToolArgs(tool, call.arguments) : call.arguments;
  const normalizedCall: ChatToolCall = args === call.arguments ? call : { ...call, arguments: args };
  const toolCallEvent: ToolCallEvent = { toolName: normalizedCall.name, input: normalizedCall.arguments };
  const hookResults = await host.emit("tool_call", {
    ...toolCallEvent,
    call: { id: normalizedCall.id, name: normalizedCall.name, args: normalizedCall.arguments },
    ...(signal ? { signal } : {}),
  });
  const blocked = blockedToolResult(normalizedCall, hookResults);
  if (blocked) {
    return emitToolResult(host, normalizedCall, blocked, signal);
  }
  const result = tool
    ? await runTool(tool, normalizedCall, signal)
    : { content: [{ type: "text", text: `tool not found: ${normalizedCall.name}` }], isError: true } as ToolExecuteResult;
  return emitToolResult(host, normalizedCall, result, signal);
}

/**
 * Tolerant input: drop schema-unknown keys before execute (models often add
 * commentary fields). Does not loosen required/typed fields — those stay enforced
 * by tool logic.
 */
export function stripUnknownToolArgs(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const properties = tool.parameters.properties;
  if (!properties || typeof properties !== "object") {
    return args;
  }
  const allowed = new Set(Object.keys(properties));
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (allowed.has(key)) {
      next[key] = value;
    } else {
      changed = true;
    }
  }
  return changed ? next : args;
}

export function blockedToolResult(call: ChatToolCall, hookResults: readonly unknown[]): ToolExecuteResult | undefined {
  for (const hook of hookResults) {
    const record = asRecord(hook);
    if (record?.block === true) {
      return {
        content: [{ type: "text", text: String(record.reason ?? `blocked ${call.name}`) }],
        isError: true,
      };
    }
  }
  return undefined;
}

export async function runTool(
  tool: ToolDefinition,
  call: ChatToolCall,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  try {
    return await tool.execute(call.id, call.arguments, { signal });
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      return {
        content: [{ type: "text", text: "tool cancelled: AbortSignal aborted during execution" }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

export async function emitToolResult(
  host: ExtensionHost,
  call: ChatToolCall,
  result: ToolExecuteResult,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  const processed = await host.emit("tool_result", {
    call: { id: call.id, name: call.name, args: call.arguments },
    result: {
      content: result.content,
      isError: result.isError,
      metadata: result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : undefined,
    },
    ...(signal ? { signal } : {}),
  });
  const originalText = toolContentText(result.content);
  for (const item of processed) {
    const record = asRecord(item);
    if (record && Array.isArray(record.content)) {
      const nextContent = record.content as ToolExecuteResult["content"];
      const nextText = toolContentText(nextContent);
      // Refuse empty hook overwrite when the tool actually returned body
      // (guards mis-parsed evolve denoise payloads).
      if (nextText.length === 0 && originalText.length > 0) {
        continue;
      }
      return {
        content: nextContent,
        isError: record.isError === true ? true : result.isError,
        details: result.details,
      };
    }
  }
  return result;
}

export function toolContentText(content: ToolExecuteResult["content"] | undefined): string {
  if (!content || content.length === 0) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  return name === "AbortError";
}
