export { ExtensionHost } from "./extension-host.ts";
export { defineTool } from "./define-tool.ts";
export { Type } from "./schema.ts";
export { runAgentLoop } from "./agent-loop.ts";
export {
  RUNTIME_EVENT_NAMES,
  RUNTIME_EVENT_SCHEMA_VERSION,
  createRuntimeEventEmitter,
  pipeRuntimeEventsToSessionUi,
  pipeRuntimeEventsToTrajectory,
  redactRuntimePayload,
  type RuntimeEventEmitter,
  type RuntimeEventName,
  type RuntimeEventV1,
} from "./events/index.ts";
export {
  AGENT_TAPE_SCHEMA_VERSION,
  AgentTapeError,
  createScriptedLlmClient,
  loadAgentTape,
  parseAgentTape,
  normalizeRuntimeEventsForGolden,
  type AgentTapeV1,
  type ScriptedLlmClient,
} from "./providers/scripted/index.ts";
export {
  SteerMailbox,
  formatFollowUpUserMessage,
  formatSteerUserMessage,
  resolveSteerMode,
  type FollowUpRequest,
  type SteerMode,
  type SteerRequest,
} from "./steer.ts";
export {
  HarnessController,
  SessionBusyError,
  isSessionBusyError,
  createTurnSnapshot,
  type HarnessPhase,
  type LiveConfigView,
  type StructuralOp,
  type TurnSnapshot,
} from "./harness/index.ts";
export { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
export {
  CONTEXT_SUMMARY_NAME,
  ContextCompactionError,
  ContextCompactionController,
  SessionHistory,
  assertCompleteToolBatches,
  compactSessionMessages,
  isContextCompactionError,
} from "./context-compaction.ts";
export { prepareSession, runSession, toDoneContract } from "./session.ts";
export {
  createStdoutSessionUiSink,
  TOOL_OUTPUT_PREVIEW_LINES,
  exploreReportBody,
  exploreReportStatus,
  formatExploreToolLabel,
  formatToolExpandHint,
  isExploreToolName,
  previewText,
  toolCallDetail,
  toolResultOutput,
} from "./session-ui.ts";
export { SessionStore } from "./session-store.ts";
export { createBuiltinTools } from "./tools/builtin.ts";
export { createLlmClient, resolveApiKey } from "./providers/client.ts";
export {
  EXPLORE_TOOL_NAME,
  PRIMARY_EXPLORE_PROMPT_ADDENDUM,
  createExploreTool,
  formatExploreResult,
  parseProviderModelRef,
  registerExploreCapability,
  resolveExploreConfig,
  runExploreSubagent,
} from "./explore/index.ts";
export {
  PLAN_DIR,
  PLAN_PROMPT_ADDENDUM,
  PLAN_TOOL_NAME,
  TASKLIST_WIDGET,
  createPlanTool,
  formatPlanSummary,
  formatTasklistWidget,
  loadPlanBoard,
  registerPlanCapability,
} from "./plan/index.ts";
export { runDoneContract, formatDoneContractFeedback } from "./verify/done-contract.ts";
export { verifyWriteBack, hashContent } from "./verify/write-back.ts";
export {
  EvidenceStore,
  EvidenceStaleError,
  WorkspaceMap,
  WorkspacePerceptionService,
  createGitNexusAdapter,
  createPerceptionTools,
  probeGitNexus,
  registerPerceptionCapability,
  QUERY_WORKSPACE_TOOL_NAME,
  READ_EVIDENCE_TOOL_NAME,
  PERCEPTION_TOOL_NAMES,
  PERCEPTION_PROMPT_ADDENDUM,
} from "./workspace/index.ts";

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
  ProviderToolChoice,
  ProviderToolChoiceScope,
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
export {
  decideTrust,
  ensureProjectTrust,
  grantTrust,
  revokeTrust,
  allowsProjectResources,
  normalizeTrustPath,
  type TrustDecision,
  type TrustMode,
  type ProjectTrustState,
} from "./project-trust.ts";
export type { ContextCompactionResult, SessionCompactionFact } from "./context-compaction.ts";
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
export type {
  CreateExploreToolOptions,
  ExploreSubagentResult,
  RegisterExploreOptions,
  ResolvedExploreConfig,
  RunExploreSubagentOptions,
} from "./explore/index.ts";
export type {
  PlanBoard,
  PlanTask,
  PlanTaskStatus,
  RegisterPlanOptions,
} from "./plan/index.ts";
