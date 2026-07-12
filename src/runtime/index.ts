export { ExtensionHost } from "./extension-host.ts";
export { defineTool } from "./define-tool.ts";
export { Type } from "./schema.ts";
export { runAgentLoop } from "./agent-loop.ts";
export {
  CONTEXT_SUMMARY_NAME,
  ContextCompactionError,
  ContextCompactionController,
  SessionHistory,
  compactSessionMessages,
  isContextCompactionError,
} from "./context-compaction.ts";
export { prepareSession, runSession, toDoneContract } from "./session.ts";
export { createStdoutSessionUiSink, TOOL_OUTPUT_PREVIEW_LINES, previewText, toolCallDetail, toolResultOutput } from "./session-ui.ts";
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
  ContextCompactionMode,
  ContextCompactionUiEvent,
  ExtensionHandler,
  JsonSchema,
  LlmClient,
  LlmCompleteOptions,
  ModelInfo,
  ProviderModelConfig,
  ProviderRegistration,
  StreamEvent,
  ThinkingDisplay,
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
export type { ContextCompactionResult } from "./context-compaction.ts";
export type { AgentLoopCheckpoint } from "./agent-loop.ts";
export type {
  SaveSessionInput,
  SessionExecution,
  SessionMetadata,
  SessionWorkspace,
  StoredSession,
} from "./session-store.ts";
export type { SessionOptions, SessionSnapshot } from "./session.ts";
export type { WriteBackResult } from "./verify/write-back.ts";
