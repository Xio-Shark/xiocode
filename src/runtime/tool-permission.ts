import {
  isToolAllowedInMode,
  type PermissionMode,
} from "./permission-mode.ts";
import { toolNeedsHighRiskGate, toolRisk } from "./tool-risk.ts";

import type { ExtensionHost } from "./extension-host.ts";
import type { InteractiveIO } from "./interactive-io.ts";
import type { SessionUiSink } from "./session-ui.ts";

/** How to treat high-risk (exec/network) tools under auto mode. */
export type HighRiskPolicy = "ask" | "deny" | "allow";

export type ToolPermissionGateOptions = Readonly<{
  host: ExtensionHost;
  interactive: InteractiveIO;
  sink: SessionUiSink;
  getMode: () => PermissionMode;
  /**
   * When set, overrides mode-derived high-risk policy (tests / CLI escape hatches).
   * Prefer leaving undefined so strict/auto/full fully control behavior.
   */
  highRiskPolicy?: HighRiskPolicy;
  /** false for `xio -p` non-interactive: auto mode denies high-risk instead of asking. */
  interactiveSession?: boolean;
}>;

export type ToolPermissionGate = Readonly<{
  getApprovedTools: () => readonly string[];
  getHighRiskPolicy: () => HighRiskPolicy;
  clearApprovals: () => void;
}>;

/**
 * Enforce permission-mode tool filters and high-risk approval on tool_call.
 * Uses the same `{ block, reason }` contract as PreToolUse hooks.
 */
export function registerToolPermissionGate(options: ToolPermissionGateOptions): ToolPermissionGate {
  const approved = new Set<string>();
  const interactiveSession = options.interactiveSession !== false;

  const resolvePolicy = (): HighRiskPolicy => {
    if (options.highRiskPolicy) return options.highRiskPolicy;
    return highRiskPolicyForMode(options.getMode(), interactiveSession);
  };

  options.host.on("tool_call", async (event) => {
    const record = asRecord(event);
    const name = toolNameFromEvent(record);
    if (!name) return;

    const mode = options.getMode();
    if (!isToolAllowedInMode(name, mode)) {
      return {
        block: true,
        reason: `tool blocked in permission mode ${mode}: ${name}`,
      };
    }

    if (!toolNeedsHighRiskGate(name)) {
      return;
    }

    if (approved.has(name)) {
      return;
    }

    const risk = toolRisk(name) ?? "exec";
    const policy = resolvePolicy();

    if (policy === "allow") {
      approved.add(name);
      options.sink.notify?.(
        `High-risk auto-allowed: ${name} (${risk})`,
        "warning",
      );
      return;
    }

    if (policy === "deny") {
      return {
        block: true,
        reason:
          `high-risk tool denied: ${name} (${risk}). Switch to full permission (Shift+Tab) `
          + "or pass --allow-high-risk / [permissions] allow_high_risk = true.",
      };
    }

    const ok = await options.interactive.ask(
      `Allow high-risk ${risk} tool "${name}" for this session? [y/N] `,
      `tool: ${name}\nrisk: ${risk}\nscope: session`,
    );
    if (!ok) {
      return {
        block: true,
        reason: `user denied high-risk tool: ${name} (${risk})`,
      };
    }
    approved.add(name);
    options.sink.notify?.(`Approved ${name} (${risk}) for this session.`, "info");
  });

  return {
    getApprovedTools: () => [...approved],
    getHighRiskPolicy: () => resolvePolicy(),
    clearApprovals: () => approved.clear(),
  };
}

export function highRiskPolicyForMode(
  mode: PermissionMode,
  interactiveSession: boolean,
): HighRiskPolicy {
  if (mode === "full") return "allow";
  if (mode === "strict") return "deny";
  return interactiveSession ? "ask" : "deny";
}

/** @deprecated Prefer permission mode; kept for CLI flag mapping. */
export function resolveHighRiskPolicy(input: Readonly<{
  allowHighRisk: boolean;
  promptOnce?: string;
}>): HighRiskPolicy {
  if (input.allowHighRisk) return "allow";
  if (input.promptOnce !== undefined) return "deny";
  return "ask";
}

function toolNameFromEvent(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  if (typeof record.toolName === "string") return record.toolName;
  const call = asRecord(record.call);
  if (call && typeof call.name === "string") return call.name;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
