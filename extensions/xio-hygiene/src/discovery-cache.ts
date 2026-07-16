/**
 * Process-level discovery cache for AGENTS.md and skills indexes.
 * Keyed by cwd + home + config fingerprint. TTL keeps mid-session file
 * edits from sticking forever in long-lived processes.
 */

import type { SpecBundle } from "./agents-md.ts";
import type { SkillsIndex } from "./skills.ts";

const DEFAULT_TTL_MS = 30_000;

type CacheEntry<T> = Readonly<{
  value: T;
  expiresAt: number;
}>;

export class DiscoveryCache {
  #agents = new Map<string, CacheEntry<SpecBundle>>();
  #skills = new Map<string, CacheEntry<SkillsIndex>>();
  #ttlMs: number;
  #now: () => number;

  constructor(options: Readonly<{ ttlMs?: number; now?: () => number }> = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  getAgents(key: string): SpecBundle | undefined {
    return this.#get(this.#agents, key);
  }

  setAgents(key: string, value: SpecBundle): void {
    this.#agents.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
  }

  getSkills(key: string): SkillsIndex | undefined {
    return this.#get(this.#skills, key);
  }

  setSkills(key: string, value: SkillsIndex): void {
    this.#skills.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
  }

  clear(): void {
    this.#agents.clear();
    this.#skills.clear();
  }

  #get<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = map.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.#now()) {
      map.delete(key);
      return undefined;
    }
    return entry.value;
  }
}

/** Shared process cache (CLI single-shot + tests may clear). */
export const processDiscoveryCache = new DiscoveryCache();

export function discoveryCacheKey(
  kind: "agents" | "skills",
  cwd: string,
  home: string | undefined,
  config: unknown,
): string {
  return `${kind}|${cwd}|${home ?? ""}|${stableFingerprint(config)}`;
}

function stableFingerprint(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
