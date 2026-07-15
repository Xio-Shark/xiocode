/**
 * @deprecated plan/build agent modes removed — use permission-mode (strict|auto|full).
 * Re-exports kept for transitional imports.
 */
export {
  DEFAULT_PERMISSION_MODE as DEFAULT_AGENT_MODE,
  allowedRiskClasses,
  cyclePermissionMode,
  filterToolsForMode,
  formatPermissionModeHelp as formatAgentModeHelp,
  isToolAllowedInMode,
  parsePermissionMode as parseAgentMode,
  permissionModeDisplay,
  permissionStatusLabel as agentStatusLabel,
  resolveInitialPermissionMode,
  risksFromActiveTools,
  type PermissionMode,
  type PermissionMode as AgentMode,
} from "./permission-mode.ts";
