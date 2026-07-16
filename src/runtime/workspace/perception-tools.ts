import { defineTool } from "../define-tool.ts";
import { Type } from "../schema.ts";

import type { ToolDefinition } from "../types.ts";
import { EvidenceStaleError } from "./evidence-store.ts";
import type { WorkspacePerceptionService } from "./service.ts";
import type { StructureQueryResult } from "./types.ts";

export const QUERY_WORKSPACE_TOOL_NAME = "query_workspace";
export const READ_EVIDENCE_TOOL_NAME = "read_evidence";

export const PERCEPTION_TOOL_NAMES = [
  QUERY_WORKSPACE_TOOL_NAME,
  READ_EVIDENCE_TOOL_NAME,
] as const;

export const PERCEPTION_PROMPT_ADDENDUM = [
  "## Workspace perception (local map + citations)",
  "Use `query_workspace` for compact structural awareness (paths, outline symbols, hashes) before bulk `grep`/`read` when surveying a tree.",
  "Every claim includes path/range/hash citations. Resolve a citation with `read_evidence` (returns stored snippet or a visible stale error).",
  "Do not treat citations as full file bodies — re-`read` the path when you need full content.",
  "Explore workers may use the same read-only query/evidence tools.",
].join("\n");

export type CreatePerceptionToolsOptions = Readonly<{
  service: WorkspacePerceptionService;
}>;

/** Product-facing query + evidence tools for main agent and explore subagents. */
export function createPerceptionTools(options: CreatePerceptionToolsOptions): readonly ToolDefinition[] {
  return [
    createQueryWorkspaceTool(options.service),
    createReadEvidenceTool(options.service),
  ];
}

function createQueryWorkspaceTool(service: WorkspacePerceptionService): ToolDefinition {
  return defineTool({
    name: QUERY_WORKSPACE_TOOL_NAME,
    label: "Query workspace",
    description:
      "Query the local workspace structure map (paths, languages, outline symbols, content hashes). "
      + "Returns compact claims with path/range/hash citations. Prefer before bulk grep when surveying. "
      + "Does not return full file bodies.",
    promptSnippet: "Structural workspace map query with resolvable citations",
    parameters: Type.Object({
      path_prefix: Type.String({ description: "Optional path prefix filter (e.g. src/runtime)." }),
      language: Type.String({ description: "Optional language filter (e.g. typescript)." }),
      query: Type.String({ description: "Optional substring match on path or outline symbol names." }),
      limit: Type.Number({ description: "Max map entries to return (default 50, max 100)." }),
    }),
    async execute(_id, params) {
      const limitRaw = typeof params.limit === "number" ? Math.floor(params.limit) : 50;
      const limit = Math.min(100, Math.max(1, limitRaw));
      const result = await service.queryStructure({
        pathPrefix: typeof params.path_prefix === "string" ? params.path_prefix.trim() || undefined : undefined,
        language: typeof params.language === "string" ? params.language.trim() || undefined : undefined,
        query: typeof params.query === "string" ? params.query.trim() || undefined : undefined,
        limit,
      });
      return textResult(formatStructureQueryResult(result));
    },
  });
}

function createReadEvidenceTool(service: WorkspacePerceptionService): ToolDefinition {
  return defineTool({
    name: READ_EVIDENCE_TOOL_NAME,
    label: "Read evidence",
    description:
      "Resolve a workspace perception citation (path + startLine + endLine + hash) to stored evidence text. "
      + "Fails visibly when the citation is missing or stale after a file mutation.",
    promptSnippet: "Resolve perception citation to stored evidence snippet",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative path from a query_workspace citation." }),
      start_line: Type.Number({ description: "1-based start line from the citation." }),
      end_line: Type.Number({ description: "1-based end line from the citation." }),
      hash: Type.String({ description: "Content hash from the citation." }),
      max_chars: Type.Number({ description: "Optional max characters to return (default 12000)." }),
    }, { required: ["path", "start_line", "end_line", "hash"] }),
    async execute(_id, params) {
      const path = typeof params.path === "string" ? params.path.trim() : "";
      const hash = typeof params.hash === "string" ? params.hash.trim() : "";
      const startLine = typeof params.start_line === "number" ? Math.floor(params.start_line) : 0;
      const endLine = typeof params.end_line === "number" ? Math.floor(params.end_line) : 0;
      if (!path || !hash || startLine < 1 || endLine < startLine) {
        return textResult(
          "read_evidence error: path, hash, start_line (>=1), end_line (>=start_line) are required",
          true,
        );
      }
      const maxChars = typeof params.max_chars === "number" && params.max_chars > 0
        ? Math.floor(params.max_chars)
        : undefined;
      try {
        const loaded = service.readEvidence(
          { path, startLine, endLine, hash },
          maxChars !== undefined ? { maxChars } : undefined,
        );
        const header = [
          `${loaded.citation.path}:${loaded.citation.startLine}-${loaded.citation.endLine}`,
          `hash=${loaded.citation.hash}`,
          loaded.truncated ? "truncated=true" : "truncated=false",
        ].join(" ");
        return textResult(`${header}\n\n${loaded.text}`);
      } catch (error) {
        if (error instanceof EvidenceStaleError) {
          return textResult(`read_evidence error: ${error.message}`, true);
        }
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`read_evidence error: ${message}`, true);
      }
    },
  });
}

export function formatStructureQueryResult(result: StructureQueryResult): string {
  const lines: string[] = [
    `backend=${result.backend} status=${result.status} elapsed_ms=${result.elapsedMs.toFixed(2)}`,
  ];
  if (result.limitation) {
    lines.push(`limitation: ${result.limitation}`);
  }
  lines.push(`entries=${result.entries.length} claims=${result.claims.length}`);
  for (const claim of result.claims) {
    const c0 = claim.citations[0];
    const cite = c0
      ? `${c0.path}:${c0.startLine}-${c0.endLine}#${c0.hash}`
      : "(no citation)";
    lines.push(`- [${claim.confidence}] ${claim.claim}  cite=${cite}`);
  }
  if (result.entries.length > result.claims.length) {
    const rest = result.entries.slice(result.claims.length, result.claims.length + 20);
    if (rest.length > 0) {
      lines.push("more_paths:");
      for (const entry of rest) {
        lines.push(`  ${entry.path} (${entry.kind}${entry.language ? `, ${entry.language}` : ""}) #${entry.hash}`);
      }
    }
  }
  return lines.join("\n");
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError: isError || undefined,
  };
}
