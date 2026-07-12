import { isToolAllowedInMode, type AgentMode } from "./agent-mode.ts";
import { toolNeedsHighRiskGate, toolRisk } from "./tool-risk.ts";

import type { ExtensionHost } from "./extension-host.ts";
import type { InteractiveIO } from "./interactive-io.ts";
import type { SessionUiSink } from "./session-ui.ts";

/** How to treat high-risk (exec/network) tools in build mode. */
export type HighRiskPolicy = "ask" | "deny" | "allow";

export type ToolPermissionGateOptions = Readonly<{
  host: ExtensionHost;
  interactive: InteractiveIO;
  sink: SessionUiSink;
  getMode: () => AgentMode;
  /** Static policy for this session (CLI/config). */
  highRiskPolicy: HighRiskPolicy;
}>;

export type ToolPermissionGate = Readonly<{
  getApprovedTools: () => readonly string[];
  getHighRiskPolicy: () => HighRiskPolicy;
}>;

/**
 * Enforce plan-mode denial and build-mode high-risk approval on tool_call.
 * Uses the same `{ block, reason }` contract as PreToolUse hooks.
 */
export function registerToolPermissionGate(options: ToolPermissionGateOptions): ToolPermissionGate {
  const approved = new Set<string>();

  options.host.on("tool_call", async (event) => {
    const record = asRecord(event);
    const name = toolNameFromEvent(record);
    if (!name) return;

    const mode = options.getMode();
    if (!isToolAllowedInMode(name, mode)) {
      return {
        block: true,
        reason: `tool blocked in agent mode ${mode}: ${name}`,
      };
    }

    if (!toolNeedsHighRiskGate(name)) {
      return;
    }

    if (approved.has(name)) {
      return;
    }

    const risk = toolRisk(name) ?? "exec";
    const policy = options.highRiskPolicy;

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
          `high-risk tool denied: ${name} (${risk}). Use an interactive session or pass --allow-high-risk / [permissions] allow_high_risk = true.`,
      };
    }

    const ok = await options.interactive.ask(
      `Allow high-risk ${risk} tool "${name}" for this session? [y/N] `,
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
    getHighRiskPolicy: () => options.highRiskPolicy,
  };
}

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
