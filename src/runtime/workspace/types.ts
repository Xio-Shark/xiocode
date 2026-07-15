export type WorkspaceBackend = "local" | "gitnexus" | "local+gitnexus";

export type WorkspaceMapStatus = "cold" | "warming" | "ready" | "degraded";

export type OutlineSymbol = Readonly<{
  name: string;
  kind: "function" | "class" | "type" | "const" | "method" | "other";
  line: number;
}>;

export type MapEntry = Readonly<{
  path: string;
  kind: "file" | "dir" | "package";
  language?: string;
  hash: string;
  bytes?: number;
  outline?: readonly OutlineSymbol[];
  imports?: readonly string[];
  testOwner?: string;
  rules?: readonly string[];
  updatedAt: number;
}>;

export type WorkspaceMapSnapshot = Readonly<{
  schema_version: "xio-workspace-map.v1";
  root: string;
  backend: WorkspaceBackend;
  entries: readonly MapEntry[];
  generatedAt: number;
}>;

export type EvidenceCitation = Readonly<{
  path: string;
  startLine: number;
  endLine: number;
  hash: string;
}>;

export type EvidenceRecord = EvidenceCitation & Readonly<{
  text: string;
  capturedAt: number;
}>;

export type PerceptionClaim = Readonly<{
  claim: string;
  confidence: "high" | "medium" | "low";
  citations: readonly EvidenceCitation[];
}>;

export type StructureQuery = Readonly<{
  pathPrefix?: string;
  language?: string;
  query?: string;
  limit?: number;
}>;

export type StructureQueryResult = Readonly<{
  backend: WorkspaceBackend;
  status: WorkspaceMapStatus;
  limitation?: string;
  claims: readonly PerceptionClaim[];
  entries: readonly Readonly<{
    path: string;
    kind: MapEntry["kind"];
    language?: string;
    hash: string;
  }>[];
  elapsedMs: number;
}>;

export type AdapterResult =
  | Readonly<{ kind: "ok"; entries: readonly MapEntry[]; backend: "gitnexus" }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export type WorkspaceIndexAdapter = Readonly<{
  name: "gitnexus" | "local";
  isAvailable: () => Promise<boolean>;
  queryStructure: (query: StructureQuery) => Promise<AdapterResult>;
}>;
