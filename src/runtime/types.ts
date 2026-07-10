export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type JsonSchema = Readonly<{
  type?: string | readonly string[];
  description?: string;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  enum?: readonly unknown[];
  [key: string]: unknown;
}>;

export type ToolContentPart = Readonly<{
  type: "text";
  text: string;
}>;

export type ToolExecuteResult = Readonly<{
  content: readonly ToolContentPart[];
  details?: unknown;
  isError?: boolean;
}>;

export type ToolDefinition = Readonly<{
  name: string;
  label?: string;
  description: string;
  promptSnippet?: string;
  parameters: JsonSchema;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolExecuteResult> | ToolExecuteResult;
}>;

export type ToolInfo = Readonly<{
  name: string;
}>;

export type ModelInfo = Readonly<{
  provider: string;
  id: string;
  name?: string;
  api?: string;
}>;

export type CommandUi = Readonly<{
  notify?: (message: string, level?: string) => unknown;
  setStatus?: (key: string, text: string | undefined) => unknown;
  setWidget?: (key: string, content: readonly string[] | undefined, options?: unknown) => unknown;
}>;

export type CommandHandlerContext = Readonly<{
  ui?: CommandUi;
  model?: ModelInfo;
  modelRegistry?: Readonly<{
    find?: (provider: string, modelId: string) => ModelInfo | undefined;
  }>;
  setModel?: (model: ModelInfo) => Promise<boolean>;
  getThinkingLevel?: () => ThinkingLevel;
  setThinkingLevel?: (level: ThinkingLevel) => void;
  getSystemPrompt?: () => string;
  hasUI?: boolean;
}>;

export type CommandOptions = Readonly<{
  description?: string;
  handler: (args?: unknown, ctx?: CommandHandlerContext) => unknown;
}>;

export type ProviderModelConfig = Readonly<{
  id: string;
  name: string;
  reasoning?: boolean;
  thinkingLevelMap?: Readonly<Partial<Record<ThinkingLevel, string>>>;
  input?: readonly ("text" | "image")[];
  cost?: Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number }>;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Readonly<Record<string, string>>;
  compat?: Readonly<Record<string, unknown>>;
}>;

export type ProviderRegistration = Readonly<{
  name: string;
  api: string;
  baseUrl?: string;
  apiKey?: string;
  authHeader?: boolean;
  models: readonly ProviderModelConfig[];
}>;

export type ToolCallEvent = Readonly<{
  toolName: string;
  input: unknown;
}>;

export type TokenUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  reasoningTokens: number | null;
}>;

export type ProviderResponseEvent = Readonly<{
  providerApi: string;
  model: string;
  usage: TokenUsage;
}>;

export type UserBashEvent = Readonly<{
  command: string;
}>;

export type SessionStartPayload = Readonly<{
  provenance?: Readonly<{
    schema_version: "xio-run-provenance.v1";
    workspace_root: string;
    main_root: string;
    base_commit: string;
    branch: string | null;
    dirty: boolean;
    dirty_summary_sha: string;
    xiocode_revision: string | null;
    created_at: string;
  }>;
}>;

export type ExtensionEventMap = {
  session_start: SessionStartPayload;
  session_end: unknown;
  before_agent_start: unknown;
  before_provider_request: unknown;
  provider_response: ProviderResponseEvent;
  turn_start: unknown;
  turn_end: unknown;
  tool_call: ToolCallEvent | Record<string, unknown>;
  tool_result: unknown;
  user_bash: UserBashEvent;
  agent_end: unknown;
  agent_start: unknown;
};

export type ExtensionEventName = keyof ExtensionEventMap;

export type ExtensionHandler<T = unknown, R = unknown> = (
  payload: T,
  ctx?: CommandHandlerContext,
) => R | Promise<R | undefined> | undefined;

export type XioExtensionAPI = {
  on: <E extends ExtensionEventName | string>(event: E, handler: ExtensionHandler) => void;
  registerTool: (tool: ToolDefinition) => void;
  registerCommand: (name: string, options: CommandOptions) => void;
  registerProvider: (name: string, config: ProviderRegistration) => void;
  getActiveTools: () => readonly string[];
  getAllTools: () => readonly ToolInfo[];
  setActiveTools: (toolNames: readonly string[]) => void;
  setModel: (model: ModelInfo) => Promise<boolean>;
  getThinkingLevel: () => ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
  readonly model: ModelInfo | undefined;
};

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatToolCall = Readonly<{
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}>;

export type ChatMessage = Readonly<{
  role: ChatRole;
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: readonly ChatToolCall[];
}>;

export type ChatCompletionRequest = Readonly<{
  model: string;
  messages: readonly ChatMessage[];
  tools?: readonly Readonly<{
    type: "function";
    function: Readonly<{
      name: string;
      description: string;
      parameters: JsonSchema;
    }>;
  }>[];
  maxTokens?: number;
  temperature?: number;
}>;

export type ChatCompletionResponse = Readonly<{
  content: string;
  toolCalls: readonly ChatToolCall[];
  usage?: TokenUsage;
  raw?: unknown;
}>;

export type LlmClient = Readonly<{
  complete: (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;
}>;
