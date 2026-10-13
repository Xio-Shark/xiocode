import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  LlmClient,
  LlmCompleteOptions,
  StreamEvent,
  TokenUsage,
} from "../types.ts";
import { openAiReasoningEffort } from "../thinking.ts";
import { emptyTokenUsage, normalizeProviderUsage } from "../usage.ts";
import { fetchWithRetry } from "./fetch-retry.ts";
import { resolveRequestControls } from "./request-controls.ts";
import {
  httpStatusError,
  modelConfig,
  providerRequestHeaders,
  readSseEvents,
  toolCallArguments,
  type ProviderClientOptions,
} from "./client.ts";

/**
 * OpenAI Responses API (`POST {base}/responses`), stateless: every request carries
 * the whole conversation and `store: false`, like the chat-completions client.
 */
export function createOpenAiResponsesClient(options: ProviderClientOptions): LlmClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${(options.registration.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/responses`;
  const headers = providerRequestHeaders(options, {
    "content-type": "application/json",
    authorization: `Bearer ${options.apiKey}`,
  });
  const emitThinking = options.registration.thinkingDisplay !== "omitted";

  const post = async (request: ChatCompletionRequest, stream: boolean, signal?: AbortSignal): Promise<Response> => {
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers,
      body: JSON.stringify(responsesBody(request, stream, options, emitThinking)),
      signal,
    }, { fetchImpl, ...options.fetchRetryOptions });
    if (!response.ok) throw await httpStatusError(response);
    return response;
  };

  async function complete(request: ChatCompletionRequest, completeOptions?: LlmCompleteOptions): Promise<ChatCompletionResponse> {
    const response = await post(request, false, completeOptions?.signal);
    return fromResponse(await response.json() as ResponsesResult);
  }

  async function* completeStream(
    request: ChatCompletionRequest,
    completeOptions?: LlmCompleteOptions,
  ): AsyncIterable<StreamEvent> {
    const response = await post(request, true, completeOptions?.signal);
    if (!response.body) throw new Error("LLM stream failed: response body is empty");

    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let content = "";
    let usage: TokenUsage = emptyTokenUsage();
    let raw: unknown;
    let completed = false;
    for await (const event of readSseEvents(response.body, completeOptions?.signal)) {
      let json: ResponsesStreamEvent;
      try {
        json = JSON.parse(event.data) as ResponsesStreamEvent;
      } catch (error) {
        throw new Error(`LLM stream parse failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      raw = json;
      const index = json.output_index ?? 0;
      if (json.type === "response.output_text.delta" && json.delta) {
        content += json.delta;
        yield { type: "text_delta", text: json.delta };
      } else if (
        (json.type === "response.reasoning_summary_text.delta" || json.type === "response.reasoning_text.delta")
        && json.delta && emitThinking
      ) {
        yield { type: "thinking_delta", text: json.delta };
      } else if (json.type === "response.output_item.added" && json.item?.type === "function_call") {
        calls.set(index, { id: json.item.call_id ?? "", name: json.item.name ?? "", arguments: json.item.arguments ?? "" });
        yield { type: "tool_call_delta", index, id: json.item.call_id, name: json.item.name };
      } else if (json.type === "response.function_call_arguments.delta" && json.delta) {
        const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
        call.arguments += json.delta;
        calls.set(index, call);
        yield { type: "tool_call_delta", index, argumentsDelta: json.delta };
      } else if (json.type === "response.function_call_arguments.done" && typeof json.arguments === "string") {
        const call = calls.get(index);
        if (call) call.arguments = json.arguments;
      } else if (json.type === "response.completed" || json.type === "response.incomplete") {
        completed = true;
        usage = normalizeProviderUsage("openai-responses", json.response ?? {});
        yield { type: "usage", usage };
      } else if (json.type === "response.failed" || json.type === "error") {
        throw new Error(`LLM stream failed: ${json.response?.error?.message ?? json.message ?? json.type}`);
      }
    }

    if (!completed) throw new Error("LLM stream failed: Responses stream ended before a terminal response event");

    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ id: call.id, name: call.name, ...toolCallArguments(call.arguments) }));
    if (toolCalls.length > 0) yield { type: "tool_calls_done", toolCalls };
    yield { type: "done", content, toolCalls, usage, raw };
  }

  return { complete, completeStream };
}

function responsesBody(
  request: ChatCompletionRequest,
  stream: boolean,
  options: ProviderClientOptions,
  emitThinking: boolean,
): Record<string, unknown> {
  const controls = resolveRequestControls({ registration: options.registration, modelId: request.model, request });
  const body: Record<string, unknown> = {
    model: request.model,
    input: buildResponsesInput(request.messages),
    tools: request.tools?.map((tool) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    })),
    max_output_tokens: request.maxTokens ?? controls.maxTokens,
    temperature: request.temperature,
    stream,
    store: false,
  };
  if (request.parallelToolCalls !== undefined) body.parallel_tool_calls = request.parallelToolCalls;
  if (controls.toolChoiceWire.kind === "openai") body.tool_choice = controls.toolChoiceWire.value;
  const effort = openAiReasoningEffort(request.thinkingLevel, modelConfig(options.registration, request.model));
  if (effort !== undefined) {
    body.reasoning = { effort, ...(emitThinking && effort !== "none" ? { summary: "auto" } : {}) };
  }
  return body;
}

/** Chat history → Responses input items; a tool call and its result are items of their own. */
export function buildResponsesInput(messages: readonly ChatMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.content.length > 0 || !message.toolCalls?.length) {
      input.push({ role: message.role, content: message.content });
    }
    for (const call of message.toolCalls ?? []) {
      input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
    }
  }
  return input;
}

function fromResponse(json: ResponsesResult): ChatCompletionResponse {
  if (json.status === "failed" || json.error) {
    throw new Error(`LLM response failed: ${json.error?.message ?? json.status}`);
  }
  const output = json.output ?? [];
  const content = output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
  const toolCalls: ChatToolCall[] = output
    .filter((item) => item.type === "function_call")
    .map((item) => ({ id: item.call_id ?? "", name: item.name ?? "", ...toolCallArguments(item.arguments) }));
  return { content, toolCalls, usage: normalizeProviderUsage("openai-responses", json), raw: json };
}

type ResponsesOutputItem = {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
};

type ResponsesResult = {
  status?: string;
  output?: ResponsesOutputItem[];
  usage?: unknown;
  error?: { message?: string } | null;
};

type ResponsesStreamEvent = {
  type?: string;
  output_index?: number;
  delta?: string;
  arguments?: string;
  item?: ResponsesOutputItem;
  response?: ResponsesResult;
  message?: string;
};
