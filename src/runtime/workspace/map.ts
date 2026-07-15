import type { MapEntry, WorkspaceBackend, WorkspaceMapSnapshot } from "./types.ts";

export class WorkspaceMap {
  readonly root: string;
  #backend: WorkspaceBackend = "local";
  readonly #entries = new Map<string, MapEntry>();

  constructor(root: string) {
    this.root = root;
  }

  get backend(): WorkspaceBackend {
    return this.#backend;
  }

  setBackend(backend: WorkspaceBackend): void {
    this.#backend = backend;
  }

  get(path: string): MapEntry | undefined {
    return this.#entries.get(normalizeRel(path));
  }

  upsert(entry: MapEntry): void {
    this.#entries.set(normalizeRel(entry.path), {
      ...entry,
      path: normalizeRel(entry.path),
      updatedAt: entry.updatedAt || Date.now(),
    });
  }

  upsertMany(entries: readonly MapEntry[]): void {
    for (const entry of entries) this.upsert(entry);
  }

  /** Invalidate a path and optional children; returns removed count. */
  invalidate(relativePath: string): number {
    const normalized = normalizeRel(relativePath);
    let removed = 0;
    for (const key of [...this.#entries.keys()]) {
      if (key === normalized || key.startsWith(`${normalized}/`)) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  list(filter?: Readonly<{ pathPrefix?: string; language?: string; limit?: number }>): MapEntry[] {
    let values = [...this.#entries.values()];
    if (filter?.pathPrefix) {
      const prefix = normalizeRel(filter.pathPrefix);
      values = values.filter((entry) => entry.path === prefix || entry.path.startsWith(`${prefix}/`));
    }
    if (filter?.language) {
      values = values.filter((entry) => entry.language === filter.language);
    }
    values.sort((a, b) => a.path.localeCompare(b.path));
    if (filter?.limit !== undefined && filter.limit >= 0) {
      values = values.slice(0, filter.limit);
    }
    return values;
  }

  size(): number {
    return this.#entries.size;
  }

  snapshot(): WorkspaceMapSnapshot {
    return {
      schema_version: "xio-workspace-map.v1",
      root: this.root,
      backend: this.#backend,
      entries: this.list(),
      generatedAt: Date.now(),
    };
  }

  loadSnapshot(snapshot: WorkspaceMapSnapshot): void {
    this.#entries.clear();
    this.#backend = snapshot.backend;
    this.upsertMany(snapshot.entries);
  }
}

function normalizeRel(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
