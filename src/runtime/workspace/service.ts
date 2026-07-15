import { createGitNexusAdapter } from "./adapter-gitnexus.ts";
import { EvidenceStore } from "./evidence-store.ts";
import { indexLocalTree, indexSingleFile } from "./local-indexer.ts";
import { WorkspaceMap } from "./map.ts";

import type {
  EvidenceCitation,
  StructureQuery,
  StructureQueryResult,
  WorkspaceMapStatus,
} from "./types.ts";

export type WorkspacePerceptionOptions = Readonly<{
  root: string;
  /** Max files for background warm. Default 2000. */
  maxFiles?: number;
  /** Inject adapters for tests. */
  gitnexus?: ReturnType<typeof createGitNexusAdapter>;
}>;

/**
 * Local incremental workspace perception plane.
 * Startup is non-blocking: construct + optional fire-and-forget ensureWarm().
 */
export class WorkspacePerceptionService {
  readonly root: string;
  readonly map: WorkspaceMap;
  readonly evidence: EvidenceStore;
  readonly #gitnexus: ReturnType<typeof createGitNexusAdapter>;
  readonly #maxFiles: number;
  #status: WorkspaceMapStatus = "cold";
  #limitation: string | undefined;
  #warmPromise: Promise<void> | undefined;

  constructor(options: WorkspacePerceptionOptions) {
    this.root = options.root;
    this.map = new WorkspaceMap(options.root);
    this.evidence = new EvidenceStore();
    this.#gitnexus = options.gitnexus ?? createGitNexusAdapter(options.root);
    this.#maxFiles = options.maxFiles ?? 2000;
  }

  get status(): WorkspaceMapStatus {
    return this.#status;
  }

  get limitation(): string | undefined {
    return this.#limitation;
  }

  /**
   * Non-blocking warm. Safe to call multiple times; shares one in-flight pass.
   */
  ensureWarm(): Promise<void> {
    if (this.#status === "ready" && this.map.size() > 0) {
      return Promise.resolve();
    }
    if (this.#warmPromise) return this.#warmPromise;
    this.#status = "warming";
    this.#warmPromise = this.#runWarm()
      .catch((error) => {
        this.#status = "degraded";
        this.#limitation = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.#warmPromise = undefined;
      });
    return this.#warmPromise;
  }

  async queryStructure(query: StructureQuery = {}): Promise<StructureQueryResult> {
    const started = performance.now();
    // Never block interactive callers on a full reindex.
    if (this.#status === "cold") {
      void this.ensureWarm();
    }
    const gitAvailable = await this.#gitnexus.isAvailable().catch(() => false);
    let limitation = this.#limitation;
    let backend: StructureQueryResult["backend"] = "local";
    if (gitAvailable) {
      const adapterResult = await this.#gitnexus.queryStructure(query);
      if (adapterResult.kind === "ok") {
        this.map.upsertMany(adapterResult.entries);
        backend = "local+gitnexus";
      } else {
        limitation = adapterResult.reason;
        backend = this.map.size() > 0 ? "local" : "local";
        if (this.#status === "ready") this.#status = "degraded";
      }
    } else if (!limitation) {
      limitation = "gitnexus unavailable; local outline only";
    }

    let entries = this.map.list({
      pathPrefix: query.pathPrefix,
      language: query.language,
      limit: query.limit ?? 50,
    });
    if (query.query) {
      const q = query.query.toLowerCase();
      entries = entries.filter((entry) =>
        entry.path.toLowerCase().includes(q)
        || entry.outline?.some((symbol) => symbol.name.toLowerCase().includes(q))
      );
    }

    const claims = entries.slice(0, 12).map((entry) => {
      const top = entry.outline?.[0];
      const citation = top
        ? {
          path: entry.path,
          startLine: top.line,
          endLine: top.line,
          hash: entry.hash,
        }
        : {
          path: entry.path,
          startLine: 1,
          endLine: 1,
          hash: entry.hash,
        };
      // Seed evidence citation metadata without full file bodies.
      if (top) {
        this.evidence.putFromText({
          path: entry.path,
          text: `${top.kind} ${top.name}`,
          startLine: top.line,
          endLine: top.line,
          fileHash: entry.hash,
        });
      }
      const confidence: "high" | "medium" | "low" = entry.outline && entry.outline.length > 0
        ? "high"
        : "medium";
      return {
        claim: top
          ? `${entry.path}: ${top.kind} ${top.name}`
          : `${entry.path} (${entry.kind}${entry.language ? `, ${entry.language}` : ""})`,
        confidence,
        citations: [citation],
      };
    });

    const elapsedMs = performance.now() - started;
    return {
      backend,
      status: this.#status,
      limitation,
      claims,
      entries: entries.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        language: entry.language,
        hash: entry.hash,
      })),
      elapsedMs,
    };
  }

  readEvidence(citation: EvidenceCitation, options?: Readonly<{ maxChars?: number }>) {
    return this.evidence.readEvidence(citation, options);
  }

  /** Apply a tool mutation (write/edit/delete) — invalidate then reindex that path only. */
  async noteMutation(
    relativePath: string,
    kind: "write" | "edit" | "delete" = "edit",
  ): Promise<void> {
    const rel = relativePath.replace(/\\/g, "/");
    this.map.invalidate(rel);
    this.evidence.invalidatePath(rel);
    if (kind === "delete") return;
    const entry = await indexSingleFile(this.root, rel);
    if (entry) this.map.upsert(entry);
  }

  async #runWarm(): Promise<void> {
    const local = await indexLocalTree({
      root: this.root,
      maxFiles: this.#maxFiles,
    });
    this.map.upsertMany(local);
    const gitAvailable = await this.#gitnexus.isAvailable().catch(() => false);
    if (gitAvailable) {
      const adapterResult = await this.#gitnexus.queryStructure({});
      if (adapterResult.kind === "ok") {
        this.map.upsertMany(adapterResult.entries);
        this.map.setBackend("local+gitnexus");
        this.#status = "ready";
        this.#limitation = undefined;
        return;
      }
      this.map.setBackend("local");
      this.#status = "degraded";
      this.#limitation = adapterResult.reason;
      return;
    }
    this.map.setBackend("local");
    this.#status = "ready";
    this.#limitation = "gitnexus unavailable; local outline only";
  }
}
