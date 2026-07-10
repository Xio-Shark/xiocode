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
  onToolStart?: (call: ChatToolCall) => void;
  onToolEnd?: (call: ChatToolCall, result: ToolExecuteResult) => void;
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
}>;

type SegmentResult = Readonly<{
  turns: number;
  finalText: string;
  toolCalls: number;
  toolErrors: number;
  usages: readonly TokenUsage[];
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

  await options.host.emit("turn_start", { prompt: userPrompt });

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const progress = await runSegments(messages, options, { maxTurns, repairTurns: verifyRepairTurns });

  await options.host.emit("turn_end", { prompt: userPrompt });
  await options.host.emit("agent_end", {
    doneContract: progress.doneContract,
    success: progress.doneContract ? progress.doneContract.passed : true,
  });

  return {
    messages,
    finalText: progress.finalText,
    doneContract: progress.doneContract,
    success: progress.doneContract ? progress.doneContract.passed : true,
    turns: progress.turns,
    toolCalls: progress.toolCalls,
    toolErrors: progress.toolErrors,
    usage: sumTokenUsage(progress.usages),
  };
}

async function runSegments(
  messages: ChatMessage[],
  options: AgentLoopOptions,
  budget: Readonly<{ maxTurns: number; repairTurns: number }>,
): Promise<LoopProgress> {
  const primary = await runUntilIdle(messages, options, budget.maxTurns);
  if (!options.doneContract) {
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
    doneContract: await runDoneContract(options.doneContract),
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
    const tools = options.host.listTools();
    const completion = await requestCompletion(messages, options, tools);
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
  }
  return { turns, finalText, toolCalls, toolErrors, usages };
}

async function requestCompletion(
  messages: ChatMessage[],
  options: AgentLoopOptions,
  tools: readonly ToolDefinition[],
): Promise<ChatCompletionResponse> {
  const providerTools = toProviderTools(tools);
  const providerPayload = { model: options.model, messages, tools: providerTools };
  const enhanced = await options.host.emit("before_provider_request", { payload: providerPayload });
  const request = asRecord(enhanced.at(-1)) ?? providerPayload;
  const requestedModel = typeof request.model === "string" ? request.model : options.model;
  const completion = await options.client.complete({
    model: requestedModel,
    messages: (Array.isArray(request.messages) ? request.messages : messages) as ChatMessage[],
    tools: Array.isArray(request.tools) ? request.tools as typeof providerTools : providerTools,
  });
  await options.host.emit("provider_response", {
    providerApi: options.providerApi ?? "unknown",
    model: requestedModel,
    usage: completion.usage ?? emptyTokenUsage(),
  });
  return completion;
}

async function appendToolResults(
  messages: ChatMessage[],
  options: AgentLoopOptions,
  calls: readonly ChatToolCall[],
): Promise<{ calls: number; errors: number }> {
  let errors = 0;
  for (const call of calls) {
    options.onToolStart?.(call);
    const result = await executeToolCall(options.host, call);
    if (result.isError === true) {
      errors += 1;
    }
    options.onToolEnd?.(call, result);
    messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: result.content.map((part) => part.text).join("\n"),
    });
  }
  return { calls: calls.length, errors };
}

async function executeToolCall(host: ExtensionHost, call: ChatToolCall): Promise<ToolExecuteResult> {
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
    ? await runTool(tool, call)
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

async function runTool(tool: ToolDefinition, call: ChatToolCall): Promise<ToolExecuteResult> {
  try {
    return await tool.execute(call.id, call.arguments);
  } catch (error) {
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
