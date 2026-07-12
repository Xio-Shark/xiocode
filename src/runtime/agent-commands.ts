import {
  DEFAULT_AGENT_MODE,
  agentStatusLabel,
  allowedRiskClasses,
  filterToolsForMode,
  formatAgentModeHelp,
  parseAgentMode,
  type AgentMode,
} from "./agent-mode.ts";
import {
  registerToolPermissionGate,
  type HighRiskPolicy,
  type ToolPermissionGate,
} from "./tool-permission.ts";

import type { ExtensionHost } from "./extension-host.ts";
import type { InteractiveIO } from "./interactive-io.ts";
import type { SessionUiSink } from "./session-ui.ts";

export type AgentCommandOptions = Readonly<{
  host: ExtensionHost;
  sink: SessionUiSink;
  interactive: InteractiveIO;
  /** Initial mode; default build. */
  initialMode?: AgentMode;
  /** High-risk tool policy for this session. */
  highRiskPolicy?: HighRiskPolicy;
}>;

export type AgentModeController = Readonly<{
  getMode: () => AgentMode;
  setMode: (mode: AgentMode) => AgentMode;
  applyFilter: () => void;
  permissionGate: ToolPermissionGate;
}>;

export function registerAgentCommands(options: AgentCommandOptions): AgentModeController {
  let mode: AgentMode = options.initialMode ?? DEFAULT_AGENT_MODE;
  const highRiskPolicy = options.highRiskPolicy ?? "ask";

  const applyFilter = (): void => {
    const registered = options.host.getAllTools().map((tool) => tool.name);
    options.host.setActiveTools(filterToolsForMode(registered, mode));
    options.host.setToolActivationFilter((name) => isAllowed(name, mode));
  };

  const setMode = (next: AgentMode): AgentMode => {
    mode = next;
    applyFilter();
    options.sink.setStatus?.("agent", agentStatusLabel(mode));
    return mode;
  };

  applyFilter();
  options.sink.setStatus?.("agent", agentStatusLabel(mode));

  const permissionGate = registerToolPermissionGate({
    host: options.host,
    interactive: options.interactive,
    sink: options.sink,
    getMode: () => mode,
    highRiskPolicy,
  });

  const handler = async (args?: unknown) => {
    const raw = typeof args === "string" ? args.trim() : "";
    if (raw.length === 0) {
      return formatAgentModeHelp(mode);
    }
    const parsed = parseAgentMode(raw.split(/\s+/)[0] ?? "");
    if (!parsed) {
      throw new Error(`unknown agent mode: ${raw} (use build|plan)`);
    }
    setMode(parsed);
    return formatAgentModeHelp(mode);
  };

  options.host.registerCommand("agent", {
    description: "Switch session agent mode (build=full tools, plan=read-oriented).",
    handler,
  });

  // Enrich /status when evolve (or others) already registered it.
  const existing = options.host.getCommand("status");
  if (existing) {
    options.host.registerCommand("status", {
      description: existing.description ?? "Show XioCode runtime and run status.",
      handler: async (args, ctx) => {
        const result = await existing.handler(args, ctx);
        const enrichment = statusEnrichment(mode, highRiskPolicy);
        if (result && typeof result === "object" && !Array.isArray(result)) {
          return { ...(result as Record<string, unknown>), ...enrichment };
        }
        return { status: result, ...enrichment };
      },
    });
  } else {
    options.host.registerCommand("status", {
      description: "Show agent mode and allowed tool risk classes.",
      handler: async () => statusEnrichment(mode, highRiskPolicy),
    });
  }

  return {
    getMode: () => mode,
    setMode,
    applyFilter,
    permissionGate,
  };
}

function statusEnrichment(mode: AgentMode, highRiskPolicy: HighRiskPolicy) {
  return {
    agent: mode,
    risks: allowedRiskClasses(mode),
    write_exec: mode === "build" ? "allowed" : "denied",
    high_risk_policy: highRiskPolicy,
    host_isolation: "unsupported",
  };
}

function isAllowed(name: string, mode: AgentMode): boolean {
  return filterToolsForMode([name], mode).length > 0;
}
