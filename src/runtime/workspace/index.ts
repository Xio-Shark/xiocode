export { createGitNexusAdapter, probeGitNexus } from "./adapter-gitnexus.ts";
export { EvidenceStore, EvidenceStaleError } from "./evidence-store.ts";
export { WorkspaceMap } from "./map.ts";
export { indexLocalTree, indexSingleFile } from "./local-indexer.ts";
export { isExcludedPath, redactSecrets, sniffLanguage } from "./privacy.ts";
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
