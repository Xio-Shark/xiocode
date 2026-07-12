/** Risk vocabulary + high-risk helpers for builtin and MCP tools. */
export type ToolRiskClass = "read" | "search" | "write" | "exec" | "network" | "merge";

const BUILTIN_RISK: Readonly<Record<string, ToolRiskClass>> = {
  read: "read",
  grep: "search",
  glob: "search",
  skill: "read",
  write: "write",
  edit: "write",
  bash: "exec",
  merge: "merge",
  rollback: "merge",
};

const HIGH_RISK = new Set<ToolRiskClass>(["exec", "network"]);

/** Map a tool or slash-command name to a risk class when known. */
export function toolRisk(name: string): ToolRiskClass | undefined {
  if (name.startsWith("mcp__")) {
    return "exec";
  }
  return BUILTIN_RISK[name];
}

export function isHighRisk(risk: ToolRiskClass): boolean {
  return HIGH_RISK.has(risk);
}

export function toolNeedsHighRiskGate(name: string): boolean {
  const risk = toolRisk(name);
  return risk !== undefined && isHighRisk(risk);
}

export function riskLabel(risk: ToolRiskClass): string {
  return risk;
}

export function allRiskClasses(): readonly ToolRiskClass[] {
  return ["read", "search", "write", "exec", "network", "merge"];
}
