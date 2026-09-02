export type {
  FlowConfig,
  FlowTask,
  FlowValidationResult,
  ReadyWave,
  ScopeConflict,
} from "./types.ts";

export {
  partitionWaves,
  readyWave,
  topoSort,
} from "./dag.ts";

export {
  detectScopeConflicts,
  normalizePattern,
  patternsOverlap,
  scopesOverlap,
  validateFlow,
} from "./scope.ts";
