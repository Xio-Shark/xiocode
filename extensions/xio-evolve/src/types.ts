import type { TokenUsage } from "../../../src/runtime/types.ts";

export type ToolCall = Readonly<{
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}>;

export type ToolResult = Readonly<{
  content: unknown;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}>;

export type ToolHookEvent = Readonly<{
  call: ToolCall;
  result?: ToolResult;
}>;

export type CommandHandlerContext = Readonly<{
  ui?: Readonly<{
    notify?: (message: string, level?: string) => unknown;
    setStatus?: (key: string, text: string | undefined) => unknown;
    setWidget?: (key: string, content: readonly string[] | undefined, options?: unknown) => unknown;
  }>;
  model?: ModelInfo;
  modelRegistry?: ModelRegistryLike;
  setModel?: (model: ModelInfo) => Promise<boolean>;
  getThinkingLevel?: () => ThinkingLevel;
  setThinkingLevel?: (level: ThinkingLevel) => void;
  getSystemPrompt?: () => string;
}>;

export type CommandOptions = Readonly<{
  description?: string;
  handler: (args?: unknown, ctx?: CommandHandlerContext) => unknown;
}>;

export type ExtensionContext = Readonly<{
  on?: (event: string, handler: (payload: unknown, ctx?: CommandHandlerContext) => unknown) => void;
  getActiveTools?: () => readonly string[];
  getAllTools?: () => readonly ToolInfo[];
  setActiveTools?: (toolNames: readonly string[]) => void;
  registerCommand?: (name: string, options: CommandOptions) => void;
  /**
   * When present, trajectory recording prefers RuntimeEvent.v1 bus sinks
   * over host tool/turn hooks (hooks still run for denoise / invalidate).
   */
  getRuntimeEvents?: () => import("../../../src/runtime/events/types.ts").RuntimeEventEmitter | undefined;
}>;

export type ModelInfo = Readonly<{
  provider: string;
  id: string;
  name?: string;
  api?: string;
  parallelToolCalls?: boolean;
  toolChoice?: ProviderToolChoice;
  thinkingDisplay?: ProviderThinkingDisplay;
}>;

export type ProviderToolChoice = "auto" | "required" | "any";
export type ProviderToolChoiceScope = "always" | "non_simple" | "never";
export type ProviderThinkingDisplay = "summarized" | "omitted";

export type ProviderToolPolicy = Readonly<{
  provider: string;
  model: string;
  api?: string;
  parallelToolCalls?: boolean;
  toolChoice?: ProviderToolChoice;
  toolChoiceScope?: ProviderToolChoiceScope;
  thinkingDisplay?: ProviderThinkingDisplay;
}>;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type ModelRegistryLike = Readonly<{
  find?: (provider: string, modelId: string) => ModelInfo | undefined;
}>;

export type ToolInfo = Readonly<{
  name: string;
}>;

export type Executable = (command: string, args: readonly string[]) => Promise<string>;

export type RunMetadata = Readonly<{
  run_id: string;
  provider: string;
  model: string;
  started_at: string;
}>;

export type TodoStatus = "pending" | "in_progress" | "done";

export type TodoItem = Readonly<{
  text: string;
  status: TodoStatus;
}>;

export type RunSummary = Readonly<{
  run_id: string;
  status: "success" | "failed";
  duration_ms: number;
  success: boolean;
  failure_reasons: readonly string[];
  finished_at: string;
  usage: TokenUsage;
}>;

export type TrajectoryTurn = Readonly<{
  turn_index: number;
  message: unknown;
  tool_results: readonly unknown[];
}>;
