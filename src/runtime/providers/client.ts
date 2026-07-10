import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  LlmClient,
  ProviderRegistration,
} from "../types.ts";
import { normalizeProviderUsage } from "../usage.ts";

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
  return {
    async complete(request) {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
          ...options.registration.models[0]?.headers,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map(toOpenAiMessage),
          tools: request.tools,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LLM request failed (${response.status}): ${body}`);
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
    },
  };
}

function createAnthropicClient(options: ProviderClientOptions): LlmClient {
  return {
    complete: (request) => completeAnthropic(request, {
      apiKey: options.apiKey,
      baseUrl: (options.registration.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, ""),
      fetchImpl: options.fetchImpl ?? fetch,
      headers: options.registration.models[0]?.headers,
    }),
  };
}

async function completeAnthropic(
  request: ChatCompletionRequest,
  options: Readonly<{
    apiKey: string;
    baseUrl: string;
    fetchImpl: typeof fetch;
    headers?: Readonly<Record<string, string>>;
  }>,
): Promise<ChatCompletionResponse> {
  const system = request.messages.filter((message) => message.role === "system")
    .map((message) => message.content).join("\n\n");
  const response = await options.fetchImpl(`${options.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01",
      ...options.headers,
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: request.maxTokens ?? 8192,
      system: system.length > 0 ? system : undefined,
      messages: request.messages.filter((message) => message.role !== "system").map(toAnthropicMessage),
      tools: request.tools?.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      })),
    }),
  });
  if (!response.ok) {
    throw new Error(`LLM request failed (${response.status}): ${await response.text()}`);
  }
  return fromAnthropicResponse(await response.json() as AnthropicResponse);
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
