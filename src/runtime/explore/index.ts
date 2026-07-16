export {
  createExploreTool,
  EXPLORE_TOOL_NAME,
  formatExploreResult,
  formatPrimaryExploreAddendum,
  PRIMARY_EXPLORE_PROMPT_ADDENDUM,
  stripMultiExploreAddendum,
} from "./explore-tool.ts";
export {
  DEFAULT_EXPLORE_ACTIVE_MAX,
  detectUserExploreFanoutRequest,
  resolveExploreConcurrencyBudget,
  ULTRA_EXPLORE_ACTIVE_MIN,
} from "./policy.ts";
export { selectExploreLane } from "./lanes.ts";
export { planExploreRoles, ownershipOverlap, EXPLORE_ROLES } from "./roles.ts";
export { buildPolicyCapsule, formatCapsuleForPrompt } from "./capsule.ts";
export {
  aggregateWorkspaceBrief,
  appendBriefGaps,
  formatWorkspaceBrief,
  DEFAULT_WORKSPACE_BRIEF_MAX_CHARS,
} from "./brief.ts";
export {
  FROZEN_AUTH_SESSION_AWARENESS,
  planDispatch,
  sampleLaneSelectionCostUs,
  scoreAwarenessCoverage,
  shouldEarlyStop,
  simulateOwnedWorkerReports,
} from "./dispatcher.ts";
export {
  ExploreOrchestrator,
  extractPathsFromText,
  formatOrchestratedExploreResult,
  parseWorkerEvidenceReport,
} from "./orchestrator.ts";
export { registerExploreCapability } from "./register.ts";
export type { ExploreCapabilityHandle } from "./register.ts";
export {
  exploreFallbackModelRef,
  parseProviderModelRef,
  resolveExploreConfig,
} from "./resolve.ts";
export type { ResolveExploreConfigOptions } from "./resolve.ts";
export {
  estimateExploreScale,
  suggestExploreConcurrency,
  tierForCount,
} from "./scale.ts";
export { Semaphore } from "./semaphore.ts";
export { formatExploreUserPrompt, runExploreSubagent, withModelId } from "./subagent.ts";
export type { SubagentUiBridge, SubagentUiScope, SubagentUiSink } from "./subagent-ui.ts";
export { noopSubagentUiBridge, scopeSubagentToolCall } from "./subagent-ui.ts";

export type { ExploreSubagentResult, ResolvedExploreConfig } from "./types.ts";
export {
  DEFAULT_EXPLORE_MAX_STARTS_PER_MINUTE,
  DEFAULT_EXPLORE_WAVE_MAX_COST_USD,
  DEFAULT_EXPLORE_WAVE_MAX_TOKENS,
  MAX_EXPLORE_CONCURRENCY,
} from "./types.ts";
export type { ExploreConcurrencyBudget, ExploreFanoutRequest } from "./policy.ts";
export type { ExploreLane, TaskExploreSignal, LaneDecision } from "./lanes.ts";
export type { ExploreRole, ExploreRoleId, RolePlan, RoleOwnership } from "./roles.ts";
export type { PolicyCapsule } from "./capsule.ts";
export type { WorkspaceBrief, WorkerEvidenceReport, BriefClaim } from "./brief.ts";
export type {
  AwarenessScore,
  DispatchPlan,
  FrozenAwarenessCase,
} from "./dispatcher.ts";
export type {
  BeginExploreWorkerInput,
  BeginExploreWorkerResult,
  CompleteExploreWorkerResult,
  ExploreGlobalBudgets,
  SkipCode,
} from "./orchestrator.ts";
export type { ExploreScaleEstimate, ExploreScaleTier } from "./scale.ts";
export type { CreateExploreToolOptions } from "./explore-tool.ts";
export type { RegisterExploreOptions } from "./register.ts";
export type { RunExploreSubagentOptions } from "./subagent.ts";
