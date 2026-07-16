export { createGitNexusAdapter, probeGitNexus } from "./adapter-gitnexus.ts";
export { EvidenceStore, EvidenceStaleError } from "./evidence-store.ts";
export { WorkspaceMap } from "./map.ts";
export { indexLocalTree, indexSingleFile } from "./local-indexer.ts";
export {
  createPerceptionTools,
  formatStructureQueryResult,
  PERCEPTION_PROMPT_ADDENDUM,
  PERCEPTION_TOOL_NAMES,
  QUERY_WORKSPACE_TOOL_NAME,
  READ_EVIDENCE_TOOL_NAME,
} from "./perception-tools.ts";
export { isExcludedPath, redactSecrets, sniffLanguage } from "./privacy.ts";
export { registerPerceptionCapability } from "./register.ts";
export { WorkspacePerceptionService } from "./service.ts";

export type {
  AdapterResult,
  EvidenceCitation,
  EvidenceRecord,
  MapEntry,
  OutlineSymbol,
  PerceptionClaim,
  StructureQuery,
  StructureQueryResult,
  WorkspaceBackend,
  WorkspaceIndexAdapter,
  WorkspaceMapSnapshot,
  WorkspaceMapStatus,
} from "./types.ts";
