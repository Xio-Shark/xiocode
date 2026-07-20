import {
  DEFAULT_PERMISSION_MODE,
  allowedRiskClasses,
  cyclePermissionMode,
  filterToolsForMode,
  formatPermissionModeHelp,
  parsePermissionMode,
  permissionModeDisplay,
  permissionStatusLabel,
  resolveInitialPermissionMode,
  type PermissionMode,
} from "./permission-mode.ts";
import {
  highRiskPolicyForMode,
  registerToolPermissionGate,
  type HighRiskPolicy,
  type ToolPermissionGate,
} from "./tool-permission.ts";

import type { ExtensionHost } from "./extension-host.ts";
import type { InteractiveIO } from "./interactive-io.ts";
import type { SessionUiSink } from "./session-ui.ts";

export type PermissionCommandOptions = Readonly<{
  host: ExtensionHost;
  sink: SessionUiSink;
  interactive: InteractiveIO;
  /** Initial mode; default auto (or full when allowHighRisk). */
  initialMode?: PermissionMode;
  allowHighRisk?: boolean;
  /** false for non-interactive `xio -p`. */
  interactiveSession?: boolean;
  /**
   * Optional static high-risk override (tests).
   * When omitted, policy follows permission mode.
   */
  highRiskPolicy?: HighRiskPolicy;
  /** Project trust decision for write/exec restrictions when untrusted. */
  getTrust?: () => import("./project-trust.ts").TrustDecision;
}>;

/** @deprecated Use PermissionCommandOptions */
export type AgentCommandOptions = PermissionCommandOptions;

export type PermissionModeController = Readonly<{
  getMode: () => PermissionMode;
  setMode: (mode: PermissionMode) => PermissionMode;
  cycleMode: () => PermissionMode;
  applyFilter: () => void;
  permissionGate: ToolPermissionGate;
}>;

/** @deprecated Use PermissionModeController */
export type AgentModeController = PermissionModeController;

export function registerPermissionCommands(
  options: PermissionCommandOptions,
): PermissionModeController {
  let mode: PermissionMode = options.initialMode
    ?? resolveInitialPermissionMode({ allowHighRisk: options.allowHighRisk === true });
  const interactiveSession = options.interactiveSession !== false;

  const permissionGate = registerToolPermissionGate({
    host: options.host,
    interactive: options.interactive,
    sink: options.sink,
    getMode: () => mode,
    interactiveSession,
    ...(options.highRiskPolicy ? { highRiskPolicy: options.highRiskPolicy } : {}),
    ...(options.getTrust ? { getTrust: options.getTrust } : {}),
  });

  const applyFilter = (): void => {
    const registered = options.host.getAllTools().map((tool) => tool.name);
    options.host.setActiveTools(filterToolsForMode(registered, mode));
    options.host.setToolActivationFilter((name) => isToolAllowedInMode(name, mode));
  };

  const setMode = (next: PermissionMode): PermissionMode => {
    const prev = mode;
    mode = next;
    if (prev === "full" && next !== "full") {
      permissionGate.clearApprovals();
    }
    applyFilter();
    options.sink.setStatus?.("permission", permissionStatusLabel(mode));
    options.sink.setStatus?.("agent", undefined);
    options.sink.notify?.(
      `权限模式: ${permissionModeDisplay(mode)} (${mode})`,
      mode === "full" ? "warning" : "info",
    );
    return mode;
  };

  const cycleMode = (): PermissionMode => setMode(cyclePermissionMode(mode));

  applyFilter();
  options.sink.setStatus?.("permission", permissionStatusLabel(mode));

  const handler = async (args?: unknown) => {
    const raw = typeof args === "string" ? args.trim() : "";
    if (raw.length === 0) {
      return formatPermissionModeHelp(mode);
    }
    const parsed = parsePermissionMode(raw.split(/\s+/)[0] ?? "");
    if (!parsed) {
      throw new Error(`unknown permission mode: ${raw} (use auto|full|strict)`);
    }
    setMode(parsed);
    return formatPermissionModeHelp(mode);
  };

  options.host.registerCommand("permission", {
    description: "Switch permission mode: auto | full | strict (Shift+Tab cycles).",
    handler,
  });
  // Keep /agent as alias pointing at permission modes (no plan/build).
  options.host.registerCommand("agent", {
    description: "Alias for /permission (auto|full|strict).",
    handler,
  });

  const existing = options.host.getCommand("status");
  if (existing) {
    options.host.registerCommand("status", {
      description: existing.description ?? "Show XioCode runtime and run status.",
      handler: async (args, ctx) => {
        const result = await existing.handler(args, ctx);
        const enrichment = statusEnrichment(
          mode,
          highRiskPolicyForMode(mode, interactiveSession),
          options.getTrust?.(),
        );
        if (result && typeof result === "object" && !Array.isArray(result)) {
          return { ...(result as Record<string, unknown>), ...enrichment };
        }
        return { status: result, ...enrichment };
      },
    });
  } else {
    options.host.registerCommand("status", {
      description: "Show permission mode and allowed tool risk classes.",
      handler: async () => statusEnrichment(
        mode,
        highRiskPolicyForMode(mode, interactiveSession),
        options.getTrust?.(),
      ),
    });
  }

  return {
    getMode: () => mode,
    setMode,
    cycleMode,
    applyFilter,
    permissionGate,
  };
}

/** @deprecated Use registerPermissionCommands */
export const registerAgentCommands = registerPermissionCommands;

function statusEnrichment(
  mode: PermissionMode,
  highRiskPolicy: HighRiskPolicy,
  trust?: import("./project-trust.ts").TrustDecision,
) {
  return {
    permission: mode,
    permission_label: permissionModeDisplay(mode),
    risks: allowedRiskClasses(mode),
    write_exec: mode === "strict" ? "denied" : "allowed",
    high_risk_policy: highRiskPolicy,
    host_isolation: "unsupported",
    ...(trust ? { project_trust: trust } : {}),
  };
}

function isToolAllowedInMode(name: string, mode: PermissionMode): boolean {
  return filterToolsForMode([name], mode).length > 0;
}

export { DEFAULT_PERMISSION_MODE, type PermissionMode };
