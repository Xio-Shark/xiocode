export type RunProvenance = Readonly<{
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

export function decodeRunProvenance(value: unknown): RunProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("run provenance must be an object");
  }
  const root = value as Record<string, unknown>;
  if (root.schema_version !== "xio-run-provenance.v1") {
    throw new Error(`unsupported schema: ${String(root.schema_version)}`);
  }
  return {
    schema_version: "xio-run-provenance.v1",
    workspace_root: String(root.workspace_root ?? ""),
    main_root: String(root.main_root ?? ""),
    base_commit: String(root.base_commit ?? ""),
    branch: typeof root.branch === "string" ? root.branch : null,
    dirty: Boolean(root.dirty),
    dirty_summary_sha: String(root.dirty_summary_sha ?? ""),
    xiocode_revision: typeof root.xiocode_revision === "string" ? root.xiocode_revision : null,
    created_at: String(root.created_at ?? ""),
  };
}
