import type { ExtensionHost } from "./extension-host.ts";
import type {
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  LlmClient,
  ToolCallEvent,
  ToolDefinition,
  ToolExecuteResult,
} from "./types.ts";
import { emptyTokenUsage, sumTokenUsage } from "./usage.ts";
import { formatDoneContractFeedback, runDoneContract } from "./verify/done-contract.ts";

import type { TokenUsage } from "./types.ts";
import type { DoneContract, DoneContractResult } from "./verify/done-contract.ts";

const WRITE_SERIAL_TOOLS = new Set(["write", "edit"]);
const DEFAULT_MAX_SESSION_MESSAGES = 80;
const CONTEXT_TRIM_NOTICE =
  "[context trimmed] Older session messages were removed to stay under max_session_messages. Continue from the remaining conversation.";

export type AgentLoopOptions = Readonly<{
  host: ExtensionHost;
  client: LlmClient;
  model: string;
  providerApi?: string;
  systemPrompt?: string;
  maxTurns?: number;
  doneContract?: DoneContract;
  /** Extra turns allowed after a failed done contract to attempt fixes. Default 3. */
  verifyRepairTurns?: number;
  onAssistantText?: (text: string) => void;
  onAssistantDelta?: (text: string) => void;
  onToolStart?: (call: ChatToolCall) => void;
  onToolEnd?: (call: ChatToolCall, result: ToolExecuteResult) => void;
  signal?: AbortSignal;
  /** When true (default), read/grep/glob/bash run concurrently; write/edit stay serial. */
  parallelToolCalls?: boolean;
  /** Prior session messages for multi-turn continuity. */
  priorMessages?: readonly ChatMessage[];
  /** Hard cap on retained session messages; trim inserts an explicit notice. */
  maxSessionMessages?: number;
}>;

export type AgentLoopResult = Readonly<{
  messages: readonly ChatMessage[];
  finalText: string;
  doneContract?: DoneContractResult;
  success: boolean;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  usage: TokenUsage;
  cancelled?: boolean;
}>;

type SegmentResult = Readonly<{
  turns: number;
  finalText: string;
  toolCalls: number;
  toolErrors: number;
  usages: readonly TokenUsage[];
  cancelled?: boolean;
}>;

type LoopProgress = SegmentResult & Readonly<{
  doneContract?: DoneContractResult;
}>;

export async function runAgentLoop(userPrompt: string, options: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxTurns = options.maxTurns ?? 40;
  const verifyRepairTurns = options.verifyRepairTurns ?? 3;
  let systemPrompt = options.systemPrompt ?? "You are XioCode, a local-first coding agent.";
  options.host.setSystemPrompt(systemPrompt);

  const beforeStart = await options.host.emit("before_agent_start", {
    prompt: userPrompt,
    systemPrompt,
    tools: options.host.listTools().map((tool) => ({ name: tool.name })),
  });
  for (const result of beforeStart) {
    const record = asRecord(result);
    if (typeof record?.systemPrompt === "string" && record.systemPrompt.length > 0) {
      systemPrompt = record.systemPrompt;
      options.host.setSystemPrompt(systemPrompt);
    }
  }

  const turnStart = await options.host.emit("turn_start", { prompt: userPrompt });
  const injectedContext = collectTurnStartContext(turnStart);

  const messages = buildMessages({
    userPrompt,
    systemPrompt,
    injectedContext,
    priorMessages: options.priorMessages,
    maxSessionMessages: Math.max(4, options.maxSessionMessages ?? DEFAULT_MAX_SESSION_MESSAGES),
  });

  if (options.signal?.aborted) {
    await emitCancelledEnd(options, undefined);
    return {
      messages,
      finalText: "",
      success: false,
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      usage: emptyTokenUsage(),
      cancelled: true,
    };
  }

  const progress = await runSegments(messages, options, { maxTurns, repairTurns: verifyRepairTurns });

  await options.host.emit("turn_end", { prompt: userPrompt });
  await options.host.emit("agent_end", {
    doneContract: progress.doneContract,
    success: progress.cancelled ? false : progress.doneContract ? progress.doneContract.passed : true,
    cancelled: progress.cancelled === true,
  });

  return {
    messages,
    finalText: progress.finalText,
    doneContract: progress.doneContract,
    success: progress.cancelled ? false : progress.doneContract ? progress.doneContract.passed : true,
    turns: progress.turns,
    toolCalls: progress.toolCalls,
    toolErrors: progress.toolErrors,
    usage: sumTokenUsage(progress.usages),
    cancelled: progress.cancelled,
  };
}

function buildMessages(input: Readonly<{
  userPrompt: string;
  systemPrompt: string;
  injectedContext: string;
  priorMessages?: readonly ChatMessage[];
  maxSessionMessages: number;
}>): ChatMessage[] {
  const prior = input.priorMessages ?? [];
  let messages: ChatMessage[];
  if (prior.length === 0) {
    messages = [
      { role: "system", content: input.systemPrompt },
      ...(input.injectedContext.length > 0
        ? [{ role: "system" as const, content: input.injectedContext }]
        : []),
      { role: "user", content: input.userPrompt },
    ];
  } else {
    messages = [...prior];
    // Keep the first system prompt stable; refresh only when prior has no system.
    if (!messages.some((message) => message.role === "system")) {
      messages.unshift({ role: "system", content: input.systemPrompt });
    }
    if (input.injectedContext.length > 0) {
      messages.push({ role: "system", content: input.injectedContext });
    }
    messages.push({ role: "user", content: input.userPrompt });
  }
  return trimSessionMessages(messages, input.maxSessionMessages);
}

export function trimSessionMessages(messages: ChatMessage[], maxSessionMessages: number): ChatMessage[] {
  if (messages.length <= maxSessionMessages) {
    return messages;
  }
  const systemPrefix: ChatMessage[] = [];
  let index = 0;
  while (index < messages.length && messages[index]?.role === "system") {
    systemPrefix.push(messages[index]!);
    index += 1;
  }
  const tailBudget = Math.max(1, maxSessionMessages - systemPrefix.length - 1);
  const tail = messages.slice(Math.max(index, messages.length - tailBudget));
  return [
    ...systemPrefix,
    { role: "user" as const, content: CONTEXT_TRIM_NOTICE },
    ...tail,
  ].slice(0, maxSessionMessages);
}

function collectTurnStartContext(results: readonly unknown[]): string {
  const parts: string[] = [];
  for (const result of results) {
    if (typeof result === "string" && result.trim().length > 0) {
      parts.push(result.trim());
      continue;
    }
    const record = asRecord(result);
    if (typeof record?.context === "string" && record.context.trim().length > 0) {
      parts.push(record.context.trim());
    }
  }
  return parts.join("\n\n");
}

async function emitCancelledEnd(options: AgentLoopOptions, doneContract: DoneContractResult | undefined): Promise<void> {
  await options.host.emit("agent_end", {
    doneContract,
    success: false,
    cancelled: true,
  });
}

async function runSegments(
  messages: ChatMessage[],
  options: AgentLoopOptions,
  budget: Readonly<{ maxTurns: number; repairTurns: number }>,
): Promise<LoopProgress> {
  const primary = await runUntilIdle(messages, options, budget.maxTurns);
  if (primary.cancelled || !options.doneContract) {
    return primary;
  }
  const firstCheck = await runDoneContract(options.doneContract);
  const repairBudget = Math.min(budget.repairTurns, budget.maxTurns - primary.turns);
  if (firstCheck.passed || repairBudget <= 0) {
    return { ...primary, doneContract: firstCheck };
  }
  messages.push({ role: "user", content: formatDoneContractFeedback(firstCheck) });
  const repair = await runUntilIdle(messages, options, repairBudget);
  return {
    turns: primary.turns + repair.turns,
    finalText: repair.finalText || primary.finalText,
    toolCalls: primary.toolCalls + repair.toolCalls,
    toolErrors: primary.toolErrors + repair.toolErrors,
    usages: [...primary.usages, ...repair.usages],
    cancelled: repair.cancelled,
    doneContract: repair.cancelled ? firstCheck : await runDoneContract(options.doneContract),
  };
}

async function runUntilIdle(
  messages: ChatMessage[],
  options: AgentLoopOptions,
  maxTurns: number,
): Promise<SegmentResult> {
  let finalText = "";
  let turns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  const usages: TokenUsage[] = [];
  for (; turns < maxTurns; turns += 1) {
    if (options.signal?.aborted) {
      return { turns, finalText, toolCalls, toolErrors, usages, cancelled: true };
    }
    const tools = options.host.listTools();
    let completion: ChatCompletionResponse;
    try {
      completion = await requestCompletion(messages, options, tools);
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) {
        return { turns, finalText, toolCalls, toolErrors, usages, cancelled: true };
      }
      throw error;
    }
    const usage = completion.usage ?? emptyTokenUsage();
    usages.push(usage);

    if (completion.content) {
      options.onAssistantText?.(completion.content);
      finalText = completion.content;
    }

    if (completion.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: completion.content });
      turns += 1;
      break;
    }

    messages.push({
      role: "assistant",
      content: completion.content,
      toolCalls: completion.toolCalls,
    });

    const metrics = await appendToolResults(messages, options, completion.toolCalls);
    toolCalls += metrics.calls;
    toolErrors += metrics.errors;
    if (metrics.cancelled) {
      return { turns: turns + 1, finalText, toolCalls, toolErrors, usages, cancelled: true };
    }
  }
  return { turns, finalText, toolCalls, toolErrors, usages };
}

async function requestCompletion(
  messages: ChatMessage[],
  options: AgentLoopOptions,
  tools: readonly ToolDefinition[],
): Promise<ChatCompletionResponse> {
  const providerTools = toProviderTools(tools);
  const providerPayload = {
    model: options.model,
    messages,
    tools: providerTools,
    parallelToolCalls: options.parallelToolCalls,
  };
  const enhanced = await options.host.emit("before_provider_request", { payload: providerPayload });
  const request = asRecord(enhanced.at(-1)) ?? providerPayload;
  const requestedModel = typeof request.model === "string" ? request.model : options.model;
  const requestMessages = (Array.isArray(request.messages) ? request.messages : messages) as ChatMessage[];
  const requestTools = Array.isArray(request.tools) ? request.tools as typeof providerTools : providerTools;
  const parallelToolCalls = typeof request.parallelToolCalls === "boolean"
    ? request.parallelToolCalls
    : options.parallelToolCalls;

  const completionRequest = {
    model: requestedModel,
    messages: requestMessages,
    tools: requestTools,
    parallelToolCalls,
  };

  let completion: ChatCompletionResponse;
  if (options.client.completeStream) {
    completion = await consumeStream(options.client, completionRequest, options);
  } else {
    completion = await options.client.complete(completionRequest, { signal: options.signal });
  }

  await options.host.emit("provider_response", {
    providerApi: options.providerApi ?? "unknown",
    model: requestedModel,
    usage: completion.usage ?? emptyTokenUsage(),
  });
  return completion;
}

async function consumeStream(
  client: LlmClient,
  request: Parameters<LlmClient["complete"]>[0],
  options: AgentLoopOptions,
): Promise<ChatCompletionResponse> {
  if (!client.completeStream) {
    return client.complete(request, { signal: options.signal });
  }
  let content = "";
  let toolCalls: ChatToolCall[] = [];
  let usage: TokenUsage = emptyTokenUsage();
  let raw: unknown;
  let sawDelta = false;
  for await (const event of client.completeStream(request, { signal: options.signal })) {
    if (event.type === "text_delta") {
      sawDelta = true;
      options.onAssistantDelta?.(event.text);
      content += event.text;
    } else if (event.type === "tool_calls_done") {
      toolCalls = [...event.toolCalls];
    } else if (event.type === "usage") {
      usage = event.usage;
    } else if (event.type === "done") {
      content = event.content;
      toolCalls = [...event.toolCalls];
      usage = event.usage;
      raw = event.raw;
    }
  }
  if (!sawDelta && content.length > 0) {
    options.onAssistantDelta?.(content);
  }
  return { content, toolCalls, usage, raw };
}

async function appendToolResults(
  messages: ChatMessage[],
  options: AgentLoopOptions,
  calls: readonly ChatToolCall[],
): Promise<{ calls: number; errors: number; cancelled?: boolean }> {
  if (options.signal?.aborted) {
    return { calls: 0, errors: 0, cancelled: true };
  }

  const parallel = options.parallelToolCalls !== false;
  const results: ToolExecuteResult[] = new Array(calls.length);
  let errors = 0;

  if (!parallel || calls.length <= 1) {
    for (let index = 0; index < calls.length; index += 1) {
      if (options.signal?.aborted) {
        return { calls: index, errors, cancelled: true };
      }
      const call = calls[index]!;
      options.onToolStart?.(call);
      const result = await executeToolCall(options.host, call, options.signal);
      results[index] = result;
      if (result.isError === true) {
        errors += 1;
      }
      options.onToolEnd?.(call, result);
    }
  } else {
    let writeChain: Promise<void> = Promise.resolve();
    const pathLocks = new Map<string, Promise<void>>();

    await Promise.all(calls.map(async (call, index) => {
      if (options.signal?.aborted) {
        results[index] = {
          content: [{ type: "text", text: "tool cancelled: AbortSignal aborted" }],
          isError: true,
        };
        return;
      }

      const run = async (): Promise<ToolExecuteResult> => {
        options.onToolStart?.(call);
        const result = await executeToolCall(options.host, call, options.signal);
        options.onToolEnd?.(call, result);
        return result;
      };

      if (WRITE_SERIAL_TOOLS.has(call.name)) {
        const filePath = typeof call.arguments.path === "string" ? String(call.arguments.path) : "";
        const previousPath = filePath.length > 0 ? (pathLocks.get(filePath) ?? Promise.resolve()) : Promise.resolve();
        const previousWrite = writeChain;
        let releasePath: () => void = () => undefined;
        const pathGate = new Promise<void>((resolve) => {
          releasePath = () => {
            resolve();
          };
        });
        if (filePath.length > 0) {
          pathLocks.set(filePath, previousPath.then(() => pathGate));
        }
        const writeTask = previousWrite
          .catch(() => undefined)
          .then(() => previousPath)
          .catch(() => undefined)
          .then(run);
        writeChain = writeTask.then(() => undefined, () => undefined).finally(() => {
          releasePath();
        });
        results[index] = await writeTask;
        return;
      }

      // read / grep / glob / bash (and unknown non-write tools) run concurrently
      results[index] = await run();
    }));

    for (const result of results) {
      if (result?.isError === true) {
        errors += 1;
      }
    }
  }

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]!;
    const result = results[index] ?? {
      content: [{ type: "text", text: `tool result missing for ${call.name}` }],
      isError: true,
    };
    messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: result.content.map((part) => part.text).join("\n"),
    });
  }

  return {
    calls: calls.length,
    errors,
    cancelled: options.signal?.aborted === true,
  };
}

async function executeToolCall(
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
  const toolCallEvent: ToolCallEvent = { toolName: call.name, input: call.arguments };
  const hookResults = await host.emit("tool_call", {
    ...toolCallEvent,
    call: { id: call.id, name: call.name, args: call.arguments },
  });
  const blocked = blockedToolResult(call, hookResults);
  if (blocked) {
    return emitToolResult(host, call, blocked);
  }
  const tool = host.getTool(call.name);
  const result = tool
    ? await runTool(tool, call, signal)
    : { content: [{ type: "text", text: `tool not found: ${call.name}` }], isError: true } as ToolExecuteResult;
  return emitToolResult(host, call, result);
}

function blockedToolResult(call: ChatToolCall, hookResults: readonly unknown[]): ToolExecuteResult | undefined {
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

async function runTool(
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

async function emitToolResult(
  host: ExtensionHost,
  call: ChatToolCall,
  result: ToolExecuteResult,
): Promise<ToolExecuteResult> {
  const processed = await host.emit("tool_result", {
    call: { id: call.id, name: call.name, args: call.arguments },
    result: {
      content: result.content,
      isError: result.isError,
      metadata: result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : undefined,
    },
  });
  for (const item of processed) {
    const record = asRecord(item);
    if (record && Array.isArray(record.content)) {
      return {
        content: record.content as ToolExecuteResult["content"],
        isError: record.isError === true,
        details: result.details,
      };
    }
  }
  return result;
}

function toProviderTools(tools: readonly ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  return name === "AbortError";
}
