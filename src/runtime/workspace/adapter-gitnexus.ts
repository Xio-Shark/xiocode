import { access } from "node:fs/promises";
import path from "node:path";

import type { AdapterResult, StructureQuery, WorkspaceIndexAdapter } from "./types.ts";

/**
 * Optional GitNexus adapter boundary.
 * When the local index is missing or stale, returns explicit unavailability —
 * never fabricates semantic symbols.
 */
export function createGitNexusAdapter(root: string): WorkspaceIndexAdapter {
  const resolved = path.resolve(root);
  return {
    name: "gitnexus",
    async isAvailable() {
      const probe = await probeGitNexus(resolved);
      return probe.available;
    },
    async queryStructure(_query: StructureQuery): Promise<AdapterResult> {
      const probe = await probeGitNexus(resolved);
      if (!probe.available) {
        return { kind: "unavailable", reason: probe.reason };
      }
      // Structural integration without fake graph results: advertise backend readiness
      // but leave symbol enrichment to a future GitNexus MCP/CLI bridge.
      return {
        kind: "unavailable",
        reason: "gitnexus index present but in-process query bridge not configured; using local fallback",
      };
    },
  };
}

export async function probeGitNexus(root: string): Promise<Readonly<{
  available: boolean;
  reason: string;
}>> {
  const candidates = [
    path.join(root, ".gitnexus"),
    path.join(root, ".gitnexus", "meta.json"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return { available: true, reason: "gitnexus artifacts present" };
    } catch {
      // try next
    }
  }
  return {
    available: false,
    reason: "gitnexus index absent (.gitnexus not found)",
  };
}
