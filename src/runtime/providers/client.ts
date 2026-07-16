import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  LlmClient,
  LlmCompleteOptions,
  ProviderModelConfig,
  ProviderRegistration,
  StreamEvent,
  TokenUsage,
} from "../types.ts";
import { emptyTokenUsage, normalizeProviderUsage } from "../usage.ts";
import {
  anthropicThinkingConfig,
  deepseekThinkingToggle,
  openAiReasoningEffort,
} from "../thinking.ts";
import { resolveRequestControls } from "./request-controls.ts";

export type ProviderClientOptions = Readonly<{
  registration: ProviderRegistration;
  apiKey: string;
  fetchImpl?: typeof fetch;
}>;

export function createLlmClient(options: ProviderClientOptions): LlmClient {
  const api = options.registration.api;
  if (api === "anthropic-messages") {
    return createAnthropicClient(options);
  }
  return createOpenAiCompatibleClient(options);
}

function createOpenAiCompatibleClient(options: ProviderClientOptions): LlmClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.registration.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${options.apiKey}`,
    ...options.registration.models[0]?.headers,
  };

  async function complete(
    request: ChatCompletionRequest,
    completeOptions?: LlmCompleteOptions,
  ): Promise<ChatCompletionResponse> {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(openAiBody(
        request,
        false,
        modelConfig(options.registration, request.model),
        options.registration,
      )),
      signal: completeOptions?.signal,
    });
    if (!response.ok) {
      throw await httpStatusError(response);
    }
    const json = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    const message = json.choices?.[0]?.message;
    const toolCalls: ChatToolCall[] = (message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function?.name ?? "",
      arguments: parseArguments(call.function?.arguments),
    }));
    return {
      content: message?.content ?? "",
      toolCalls,
      usage: normalizeProviderUsage("openai-completions", json),
      raw: json,
    };
  }

  async function* completeStream(
    request: ChatCompletionRequest,
    completeOptions?: LlmCompleteOptions,
  ): AsyncIterable<StreamEvent> {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(openAiBody(
        request,
        true,
        modelConfig(options.registration, request.model),
        options.registration,
      )),
      signal: completeOptions?.signal,
    });
    if (!response.ok) {
      throw await httpStatusError(response);
    }
    if (!response.body) {
      throw new Error("LLM stream failed: response body is empty");
    }

    const toolBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    let content = "";
    let usage: TokenUsage = emptyTokenUsage();
    let raw: unknown;
    const emitThinking = options.registration.thinkingDisplay !== "omitted";

    for await (const data of readSseDataLines(response.body, completeOptions?.signal)) {
      if (data === "[DONE]") {
        break;
      }
      let json: OpenAiStreamChunk;
      try {
        json = JSON.parse(data) as OpenAiStreamChunk;
      } catch (error) {
        throw new Error(`LLM stream parse failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      raw = json;
      const choice = json.choices?.[0];
      const delta = choice?.delta;
      const reasoning = openAiReasoningText(delta);
      if (emitThinking && reasoning) {
        yield { type: "thinking_delta", text: reasoning };
      }
      if (typeof delta?.content === "string" && delta.content.length > 0) {
        content += delta.content;
        yield { type: "text_delta", text: delta.content };
      }
      for (const toolDelta of delta?.tool_calls ?? []) {
        const index = toolDelta.index ?? 0;
        const current = toolBuffers.get(index) ?? { id: "", name: "", arguments: "" };
        if (toolDelta.id) {
          current.id = toolDelta.id;
        }
        if (toolDelta.function?.name) {
          current.name = toolDelta.function.name;
        }
        if (toolDelta.function?.arguments) {
          current.arguments += toolDelta.function.arguments;
        }
        toolBuffers.set(index, current);
        yield {
          type: "tool_call_delta",
          index,
          id: toolDelta.id,
          name: toolDelta.function?.name,
          argumentsDelta: toolDelta.function?.arguments,
        };
      }
      if (json.usage) {
        usage = normalizeProviderUsage("openai-completions", json) ?? emptyTokenUsage();
        yield { type: "usage", usage };
      }
    }

    const toolCalls = [...toolBuffers.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, value]) => ({
        id: value.id,
        name: value.name,
        arguments: parseArguments(value.arguments),
      }));
    if (toolCalls.length > 0) {
      yield { type: "tool_calls_done", toolCalls };
    }
    yield { type: "done", content, toolCalls, usage, raw };
  }

  return { complete, completeStream };
}

function openAiBody(
  request: ChatCompletionRequest,
  stream: boolean,
  model: ProviderModelConfig | undefined,
  registration?: ProviderRegistration,
): Record<string, unknown> {
  const controls = resolveRequestControls({
    registration,
    modelId: request.model,
    request,
  });
  const maxTokens = request.maxTokens ?? controls.maxTokens;
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(toOpenAiMessage),
    tools: request.tools,
    max_tokens: maxTokens,
    temperature: request.temperature,
    stream,
  };
  if (request.parallelToolCalls !== undefined) {
    body.parallel_tool_calls = request.parallelToolCalls;
  }
  if (stream) {
    body.stream_options = { include_usage: true };
  }
  if (controls.toolChoiceWire.kind === "openai") {
    body.tool_choice = controls.toolChoiceWire.value;
  }
  // Official OpenAI prompt-cache passthrough only when explicitly configured.
  const cacheKey = model?.compat?.prompt_cache_key;
  if (typeof cacheKey === "string" && cacheKey.length > 0 && controls.promptCache) {
    body.prompt_cache_key = cacheKey;
  }
  const effort = openAiReasoningEffort(request.thinkingLevel, model);
  if (effort !== undefined) {
    body.reasoning_effort = effort;
  }
  // DeepSeek V4: thinking toggle + effort (see api-docs.deepseek.com/guides/thinking_mode)
  const thinking = deepseekThinkingToggle(request.thinkingLevel, model);
  if (thinking) {
    body.thinking = thinking;
  }
  return body;
}

function createAnthropicClient(options: ProviderClientOptions): LlmClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.registration.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const headers = {
    "content-type": "application/json",
    "x-api-key": options.apiKey,
    "anthropic-version": "2023-06-01",
    ...options.registration.models[0]?.headers,
  };

  async function complete(
    request: ChatCompletionRequest,
    completeOptions?: LlmCompleteOptions,
  ): Promise<ChatCompletionResponse> {
    return completeAnthropic(request, {
      baseUrl,
      headers,
      fetchImpl,
      signal: completeOptions?.signal,
      stream: false,
      model: modelConfig(options.registration, request.model),
      thinkingDisplay: options.registration.thinkingDisplay,
      registration: options.registration,
    });
  }

  async function* completeStream(
    request: ChatCompletionRequest,
    completeOptions?: LlmCompleteOptions,
  ): AsyncIterable<StreamEvent> {
    const response = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(anthropicBody(
        request,
        true,
        modelConfig(options.registration, request.model),
        options.registration.thinkingDisplay,
        options.registration,
      )),
      signal: completeOptions?.signal,
    });
    if (!response.ok) {
      throw await httpStatusError(response);
    }
    if (!response.body) {
      throw new Error("LLM stream failed: response body is empty");
    }

    const toolBuffers = new Map<number, { id: string; name: string; inputJson: string }>();
    let content = "";
    let usage: TokenUsage = emptyTokenUsage();
    let raw: unknown;
    const emitThinking = options.registration.thinkingDisplay !== "omitted";

    for await (const event of readSseEvents(response.body, completeOptions?.signal)) {
      let json: AnthropicStreamEvent;
      try {
        json = JSON.parse(event.data) as AnthropicStreamEvent;
      } catch (error) {
        throw new Error(`LLM stream parse failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      raw = json;
      if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
        const index = json.index ?? 0;
        toolBuffers.set(index, {
          id: json.content_block.id ?? "",
          name: json.content_block.name ?? "",
          inputJson: "",
        });
        yield {
          type: "tool_call_delta",
          index,
          id: json.content_block.id,
          name: json.content_block.name,
        };
      } else if (json.type === "content_block_start" && json.content_block?.type === "thinking") {
        const seed = json.content_block.thinking;
        if (emitThinking && typeof seed === "string" && seed.length > 0) {
          yield { type: "thinking_delta", text: seed };
        }
      } else if (json.type === "content_block_delta") {
        const index = json.index ?? 0;
        if (json.delta?.type === "text_delta" && typeof json.delta.text === "string") {
          content += json.delta.text;
          yield { type: "text_delta", text: json.delta.text };
        } else if (json.delta?.type === "thinking_delta") {
          const thinkingText = typeof json.delta.thinking === "string"
            ? json.delta.thinking
            : typeof json.delta.text === "string"
              ? json.delta.text
              : undefined;
          if (emitThinking && thinkingText && thinkingText.length > 0) {
            yield { type: "thinking_delta", text: thinkingText };
          }
        } else if (json.delta?.type === "input_json_delta" && typeof json.delta.partial_json === "string") {
          const current = toolBuffers.get(index) ?? { id: "", name: "", inputJson: "" };
          current.inputJson += json.delta.partial_json;
          toolBuffers.set(index, current);
          yield {
            type: "tool_call_delta",
            index,
            argumentsDelta: json.delta.partial_json,
          };
        }
      } else if (json.type === "message_delta" && json.usage) {
        usage = normalizeProviderUsage("anthropic-messages", { usage: json.usage }) ?? emptyTokenUsage();
        yield { type: "usage", usage };
      } else if (json.type === "message_start" && json.message?.usage) {
        usage = normalizeProviderUsage("anthropic-messages", { usage: json.message.usage }) ?? emptyTokenUsage();
        yield { type: "usage", usage };
      }
    }

    const toolCalls = [...toolBuffers.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, value]) => ({
        id: value.id,
        name: value.name,
        arguments: parseArguments(value.inputJson || "{}"),
      }));
    if (toolCalls.length > 0) {
      yield { type: "tool_calls_done", toolCalls };
    }
    yield { type: "done", content, toolCalls, usage, raw };
  }

  return { complete, completeStream };
}

async function completeAnthropic(
  request: ChatCompletionRequest,
  options: Readonly<{
    baseUrl: string;
    headers: Record<string, string>;
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
    stream: boolean;
    model?: ProviderModelConfig;
    thinkingDisplay?: ProviderRegistration["thinkingDisplay"];
    registration?: ProviderRegistration;
  }>,
): Promise<ChatCompletionResponse> {
  const response = await options.fetchImpl(`${options.baseUrl}/v1/messages`, {
    method: "POST",
    headers: options.headers,
    body: JSON.stringify(anthropicBody(
      request,
      false,
      options.model,
      options.thinkingDisplay,
      options.registration,
    )),
    signal: options.signal,
  });
  if (!response.ok) {
    throw await httpStatusError(response);
  }
  return fromAnthropicResponse(await response.json() as AnthropicResponse);
}

function anthropicBody(
  request: ChatCompletionRequest,
  stream: boolean,
  model: ProviderModelConfig | undefined,
  thinkingDisplay?: ProviderRegistration["thinkingDisplay"],
  registration?: ProviderRegistration,
): Record<string, unknown> {
  const controls = resolveRequestControls({
    registration: registration ?? (model
      ? { name: "", api: "anthropic-messages", models: [model] }
      : undefined),
    modelId: request.model,
    request,
  });
  const { stable, dynamic } = splitSystemMessages(request.messages);
  const system = buildAnthropicSystem(stable, dynamic, controls.promptCache);
  const tools = request.tools?.map((tool, index, list) => {
    const entry: Record<string, unknown> = {
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    };
    // Official Anthropic cache breakpoint on the last tool schema when caching enabled.
    if (controls.promptCache && index === list.length - 1) {
      entry.cache_control = { type: "ephemeral" };
    }
    return entry;
  });
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens ?? controls.maxTokens ?? 8192,
    system,
    messages: request.messages.filter((message) => message.role !== "system").map(toAnthropicMessage),
    tools,
    stream,
  };
  if (controls.toolChoiceWire.kind === "anthropic") {
    body.tool_choice = controls.toolChoiceWire.value;
  }
  const thinking = anthropicThinkingConfig(request.thinkingLevel, model, thinkingDisplay);
  if (thinking) {
    body.thinking = thinking;
  }
  return body;
}

/**
 * Leading system messages form the cacheable prefix; system messages that appear
 * after history (e.g. turn_start inject) are dynamic tail and must not own the
 * cache_control breakpoint (design D4: last *stable* system block).
 */
function splitSystemMessages(messages: readonly ChatMessage[]): Readonly<{
  stable: readonly string[];
  dynamic: readonly string[];
}> {
  const stable: string[] = [];
  const dynamic: string[] = [];
  let seenNonSystem = false;
  for (const message of messages) {
    if (message.role === "system") {
      const text = message.content.trim();
      if (text.length === 0) continue;
      if (seenNonSystem) dynamic.push(text);
      else stable.push(text);
      continue;
    }
    seenNonSystem = true;
  }
  return { stable, dynamic };
}

function buildAnthropicSystem(
  stable: readonly string[],
  dynamic: readonly string[],
  promptCache: boolean,
): string | Array<Record<string, unknown>> | undefined {
  const all = [...stable, ...dynamic];
  if (all.length === 0) return undefined;
  // Keep a single stable text when not caching; structured blocks only when cache markers apply.
  if (!promptCache) {
    const joined = all.join("\n\n");
    return joined.length > 0 ? joined : undefined;
  }
  const blocks: Array<Record<string, unknown>> = [];
  for (let index = 0; index < stable.length; index += 1) {
    const block: Record<string, unknown> = { type: "text", text: stable[index] };
    // Breakpoint on last stable block so dynamic injects do not invalidate prefix cache.
    if (index === stable.length - 1) {
      block.cache_control = { type: "ephemeral" };
    }
    blocks.push(block);
  }
  for (const text of dynamic) {
    blocks.push({ type: "text", text });
  }
  return blocks.length > 0 ? blocks : undefined;
}

function modelConfig(
  registration: ProviderRegistration,
  modelId: string,
): ProviderModelConfig | undefined {
  return registration.models.find((model) => model.id === modelId);
}

function toAnthropicMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }],
    };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...message.toolCalls.map((call) => ({
          type: "tool_use", id: call.id, name: call.name, input: call.arguments,
        })),
      ],
    };
  }
  return { role: message.role === "assistant" ? "assistant" : "user", content: message.content };
}

function fromAnthropicResponse(json: AnthropicResponse): ChatCompletionResponse {
  const content = json.content ?? [];
  const toolCalls: ChatToolCall[] = content.filter((part) => part.type === "tool_use").map((part) => ({
    id: part.id ?? "",
    name: part.name ?? "",
    arguments: part.input ?? {},
  }));
  return {
    content: content.filter((part) => part.type === "text").map((part) => part.text ?? "").join(""),
    toolCalls,
    usage: normalizeProviderUsage("anthropic-messages", json),
    raw: json,
  };
}

type AnthropicResponse = {
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  usage?: unknown;
};

type OpenAiStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: unknown;
};

type AnthropicStreamEvent = {
  type?: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    thinking?: string;
  };
  usage?: unknown;
  message?: {
    usage?: unknown;
  };
};

function openAiReasoningText(
  delta: Readonly<{ reasoning_content?: string | null; reasoning?: string | null }> | undefined,
): string | undefined {
  if (!delta) return undefined;
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
    return delta.reasoning_content;
  }
  if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
    return delta.reasoning;
  }
  return undefined;
}

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    };
  }
  return {
    role: message.role,
    content: message.content,
  };
}

function parseArguments(value: string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

async function* readSseDataLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  for await (const event of readSseEvents(body, signal)) {
    if (event.data.length > 0) {
      yield event.data;
    }
  }
}

async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const parsed = parseSseBlock(part);
        if (parsed) {
          yield parsed;
        }
      }
    }
    if (buffer.trim().length > 0) {
      const parsed = parseSseBlock(buffer);
      if (parsed) {
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): { event?: string; data: string } | undefined {
  const lines = block.split(/\r?\n/);
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  return { event, data: dataLines.join("\n") };
}

/** Status-only failure — response bodies can echo API keys. */
async function httpStatusError(response: Response): Promise<Error> {
  await response.text().catch(() => undefined);
  return new Error(`LLM request failed (${response.status})`);
}

export function resolveApiKey(registration: ProviderRegistration, env: NodeJS.ProcessEnv = process.env): string {
  const raw = registration.apiKey ?? "";
  if (raw.startsWith("$")) {
    const envName = raw.slice(1);
    const value = env[envName];
    if (!value) {
      throw new Error(`missing API key env: ${envName}`);
    }
    return value;
  }
  if (raw.length > 0) {
    return raw;
  }
  throw new Error(`provider ${registration.name} has no apiKey configured`);
}

export type { ChatCompletionRequest, ChatCompletionResponse };
