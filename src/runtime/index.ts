export { ExtensionHost } from "./extension-host.ts";
export { defineTool } from "./define-tool.ts";
export { Type } from "./schema.ts";
export { runAgentLoop, trimSessionMessages } from "./agent-loop.ts";
export { prepareSession, runSession, toDoneContract } from "./session.ts";
export { createStdoutSessionUiSink } from "./session-ui.ts";
export { SessionStore } from "./session-store.ts";
export { createBuiltinTools } from "./tools/builtin.ts";
export { createLlmClient, resolveApiKey } from "./providers/client.ts";
export { runDoneContract, formatDoneContractFeedback } from "./verify/done-contract.ts";
export { verifyWriteBack, hashContent } from "./verify/write-back.ts";

export type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  CommandHandlerContext,
  CommandOptions,
  ExtensionHandler,
  JsonSchema,
  LlmClient,
  LlmCompleteOptions,
  ModelInfo,
  ProviderModelConfig,
  ProviderRegistration,
  StreamEvent,
  ThinkingLevel,
  ToolCallEvent,
  ToolDefinition,
  ToolExecuteContext,
  ToolExecuteResult,
  ToolInfo,
  UserBashEvent,
  XioExtensionAPI,
} from "./types.ts";

export type { DoneContract, DoneContractResult, DoneCommand } from "./verify/done-contract.ts";
export type { SessionUiSink } from "./session-ui.ts";
export type { SaveSessionInput, SessionMetadata, StoredSession } from "./session-store.ts";
export type { SessionOptions, SessionSnapshot } from "./session.ts";
export type { WriteBackResult } from "./verify/write-back.ts";
