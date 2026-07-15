import { createHash } from "node:crypto";

import type { JsonSchema, ToolDefinition } from "../types.ts";

export type ProviderFunctionTool = Readonly<{
  type: "function";
  function: Readonly<{
    name: string;
    description: string;
    parameters: JsonSchema;
  }>;
}>;

type CacheEntry = Readonly<{
  key: string;
  tools: readonly ProviderFunctionTool[];
}>;

const cache = new Map<string, CacheEntry>();
const SCHEMA_VERSION = "v1";

/** Test-only: clear process-wide tool schema cache. */
export function resetToolSchemaCacheForTests(): void {
  cache.clear();
}

/**
 * Convert host tools to provider function tools with deterministic ordering
 * and process-level caching by api + tool-set fingerprint.
 */
export function getCachedProviderTools(
  api: string,
  tools: readonly ToolDefinition[],
): Readonly<{ tools: readonly ProviderFunctionTool[]; cache: "hit" | "miss"; key: string }> {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const key = fingerprint(api, sorted);
  const existing = cache.get(key);
  if (existing) {
    return { tools: existing.tools, cache: "hit", key };
  }
  const converted: ProviderFunctionTool[] = sorted.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
  cache.set(key, { key, tools: converted });
  // Bound memory: drop oldest when large
  if (cache.size > 64) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  return { tools: converted, cache: "miss", key };
}

function fingerprint(api: string, tools: readonly ToolDefinition[]): string {
  const payload = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  return createHash("sha256")
    .update(SCHEMA_VERSION)
    .update("\0")
    .update(api)
    .update("\0")
    .update(stableStringify(payload))
    .digest("hex")
    .slice(0, 32);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
