import type { ExtensionHost } from "./extension-host.ts";
import type {
  ChatMessage,
  ChatToolCall,
  LlmClient,
  ToolCallEvent,
  ToolDefinition,
  ToolExecuteResult,
} from "./types.ts";
import { formatDoneContractFeedback, runDoneContract } from "./verify/done-contract.ts";

import type { DoneContract, DoneContractResult } from "./verify/done-contract.ts";

export type AgentLoopOptions = Readonly<{
  host: ExtensionHost;
  client: LlmClient;
  model: string;
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

  let finalText = "";
  let turnsUsed = 0;
  let doneContractResult: DoneContractResult | undefined;

  while (turnsUsed < maxTurns) {
    const turnBudget = maxTurns - turnsUsed;
    const segment = await runUntilIdle(messages, options, turnBudget);
    turnsUsed += segment.turns;
    finalText = segment.finalText || finalText;

    if (!options.doneContract) {
      break;
    }

    doneContractResult = await runDoneContract(options.doneContract);
    if (doneContractResult.passed) {
      break;
    }

    if (turnsUsed >= maxTurns || verifyRepairTurns <= 0) {
      break;
    }

    const repairBudget = Math.min(verifyRepairTurns, maxTurns - turnsUsed);
    if (repairBudget <= 0) {
      break;
    }

    messages.push({
      role: "user",
      content: formatDoneContractFeedback(doneContractResult),
    });
    const repair = await runUntilIdle(messages, options, repairBudget);
    turnsUsed += repair.turns;
    finalText = repair.finalText || finalText;
    doneContractResult = await runDoneContract(options.doneContract);
    break;
  }

  await options.host.emit("turn_end", { prompt: userPrompt });
  await options.host.emit("agent_end", {
    doneContract: doneContractResult,
    success: doneContractResult ? doneContractResult.passed : true,
  });

  return {
    messages,
    finalText,
    doneContract: doneContractResult,
    success: doneContractResult ? doneContractResult.passed : true,
  };
}

async function runUntilIdle(
  messages: ChatMessage[],
  options: AgentLoopOptions,
  maxTurns: number,
): Promise<{ turns: number; finalText: string }> {
  let finalText = "";
  let turns = 0;
  for (; turns < maxTurns; turns += 1) {
    const tools = options.host.listTools();
    const providerPayload = {
      model: options.model,
      messages,
      tools: toProviderTools(tools),
    };
    const enhanced = await options.host.emit("before_provider_request", { payload: providerPayload });
    const request = asRecord(enhanced.at(-1)) ?? providerPayload;
    const completion = await options.client.complete({
      model: typeof request.model === "string" ? request.model : options.model,
      messages: (Array.isArray(request.messages) ? request.messages : messages) as ChatMessage[],
      tools: Array.isArray(request.tools) ? request.tools as ReturnType<typeof toProviderTools> : toProviderTools(tools),
    });

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

    for (const call of completion.toolCalls) {
      options.onToolStart?.(call);
      const result = await executeToolCall(options.host, call);
      options.onToolEnd?.(call, result);
      const text = result.content.map((part) => part.text).join("\n");
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: text,
      });
    }
  }
  return { turns, finalText };
}

async function executeToolCall(host: ExtensionHost, call: ChatToolCall): Promise<ToolExecuteResult> {
  const toolCallEvent: ToolCallEvent = { toolName: call.name, input: call.arguments };
  const hookResults = await host.emit("tool_call", {
    ...toolCallEvent,
    call: { id: call.id, name: call.name, args: call.arguments },
  });
  for (const hook of hookResults) {
    const record = asRecord(hook);
    if (record?.block === true) {
      const blocked: ToolExecuteResult = {
        content: [{ type: "text", text: String(record.reason ?? `blocked ${call.name}`) }],
        isError: true,
      };
      await host.emit("tool_result", {
        call: { id: call.id, name: call.name, args: call.arguments },
        result: { content: blocked.content, isError: true },
      });
      return blocked;
    }
  }

  const tool = host.getTool(call.name);
  if (!tool) {
    const missing: ToolExecuteResult = {
      content: [{ type: "text", text: `tool not found: ${call.name}` }],
      isError: true,
    };
    await host.emit("tool_result", {
      call: { id: call.id, name: call.name, args: call.arguments },
      result: { content: missing.content, isError: true },
    });
    return missing;
  }

  let result: ToolExecuteResult;
  try {
    result = await tool.execute(call.id, call.arguments);
  } catch (error) {
    result = {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }

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
