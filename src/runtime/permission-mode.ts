import { toolRisk, type ToolRiskClass } from "./tool-risk.ts";

/**
 * Session permission modes (replaces plan/build).
 * Cycle: auto → full → strict → auto (Shift+Tab / /permission).
 */
export type PermissionMode = "strict" | "auto" | "full";

/** Read/search-oriented tools allowed in strict mode. */
const STRICT_ALLOWED = new Set(["read", "grep", "glob", "skill", "explore"]);

export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

export const PERMISSION_MODE_ORDER: readonly PermissionMode[] = ["auto", "full", "strict"];

export function parsePermissionMode(raw: string): PermissionMode | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "strict" || value === "s" || value === "严格") return "strict";
  if (value === "auto" || value === "a" || value === "自动") return "auto";
  if (value === "full" || value === "f" || value === "完全" || value === "yolo") return "full";
  return undefined;
}

export function cyclePermissionMode(current: PermissionMode): PermissionMode {
  const index = PERMISSION_MODE_ORDER.indexOf(current);
  const next = PERMISSION_MODE_ORDER[(index + 1) % PERMISSION_MODE_ORDER.length];
  return next ?? DEFAULT_PERMISSION_MODE;
}

/** Whether a registered tool name is active under the given mode. */
export function isToolAllowedInMode(toolName: string, mode: PermissionMode): boolean {
  if (mode === "auto" || mode === "full") return true;
  if (toolName.startsWith("mcp__")) return false;
  return STRICT_ALLOWED.has(toolName);
}

export function filterToolsForMode(
  toolNames: readonly string[],
  mode: PermissionMode,
): string[] {
  return toolNames.filter((name) => isToolAllowedInMode(name, mode));
}

/** Risk classes the current mode permits for tools/commands. */
export function allowedRiskClasses(mode: PermissionMode): readonly ToolRiskClass[] {
  if (mode === "strict") {
    return ["read", "search", "merge"];
  }
  return ["read", "search", "write", "exec", "network", "merge"];
}

export function permissionStatusLabel(mode: PermissionMode): string {
  return `perm:${mode}`;
}

export function permissionModeDisplay(mode: PermissionMode): string {
  if (mode === "strict") return "严格";
  if (mode === "full") return "完全";
  return "自动";
}

export function formatPermissionModeHelp(mode: PermissionMode): string {
  const label = permissionModeDisplay(mode);
  const detail = mode === "strict"
    ? "read/search only — write/exec/MCP denied"
    : mode === "full"
      ? "all tools; high-risk auto-allowed"
      : "all tools; high-risk asks once per tool (non-interactive: deny)";
  return [
    `permission mode: ${mode} (${label})`,
    detail,
    `risks: ${allowedRiskClasses(mode).join(",")}`,
    "usage: /permission [auto|full|strict]  ·  Shift+Tab cycles",
    "aliases: a/f/s · 自动/完全/严格",
  ].join("\n");
}

/** Derive allowed risks from active tool names (for status enrichment). */
export function risksFromActiveTools(toolNames: readonly string[]): readonly ToolRiskClass[] {
  const set = new Set<ToolRiskClass>();
  for (const name of toolNames) {
    const risk = toolRisk(name);
    if (risk) set.add(risk);
  }
  return [...set];
}

/**
 * Resolve initial mode from CLI/config.
 * allowHighRisk → full; otherwise default auto (strict only if explicitly configured later).
 */
export function resolveInitialPermissionMode(input: Readonly<{
  allowHighRisk: boolean;
  configured?: PermissionMode;
}>): PermissionMode {
  if (input.allowHighRisk) return "full";
  return input.configured ?? DEFAULT_PERMISSION_MODE;
}
