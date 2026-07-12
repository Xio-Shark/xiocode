import { toolRisk, type ToolRiskClass } from "./tool-risk.ts";

export type AgentMode = "build" | "plan";

const PLAN_ALLOWED = new Set(["read", "grep", "glob", "skill"]);

export const DEFAULT_AGENT_MODE: AgentMode = "build";

export function parseAgentMode(raw: string): AgentMode | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "build" || value === "b") return "build";
  if (value === "plan" || value === "p") return "plan";
  return undefined;
}

/** Whether a registered tool name is active under the given mode. */
export function isToolAllowedInMode(toolName: string, mode: AgentMode): boolean {
  if (mode === "build") return true;
  // plan: read/search only — MCP is host-reaching (exec) and must not slip through
  if (toolName.startsWith("mcp__")) return false;
  return PLAN_ALLOWED.has(toolName);
}

export function filterToolsForMode(
  toolNames: readonly string[],
  mode: AgentMode,
): string[] {
  return toolNames.filter((name) => isToolAllowedInMode(name, mode));
}

/** Risk classes the current mode permits for tools/commands. */
export function allowedRiskClasses(mode: AgentMode): readonly ToolRiskClass[] {
  if (mode === "build") {
    return ["read", "search", "write", "exec", "network", "merge"];
  }
  // plan: read/search; merge commands remain available; no write/exec/network tools
  return ["read", "search", "merge"];
}

export function agentStatusLabel(mode: AgentMode): string {
  return `agent:${mode}`;
}

export function formatAgentModeHelp(mode: AgentMode): string {
  const risks = allowedRiskClasses(mode).join(",");
  const writeExec = mode === "build" ? "write+exec allowed (high-risk may ask)" : "write+exec+mcp denied";
  return [
    `agent mode: ${mode}`,
    writeExec,
    `risks: ${risks}`,
    "usage: /agent [build|plan]  (aliases: b, p)",
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
