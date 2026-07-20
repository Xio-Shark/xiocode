import {
  isToolAllowedInMode,
  type PermissionMode,
} from "./permission-mode.ts";
import { toolNeedsHighRiskGate, toolRisk } from "./tool-risk.ts";
import {
  allowsProjectResources,
  type TrustDecision,
} from "./project-trust.ts";

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
  /**
   * Project trust decision. Untrusted workspaces restrict write/exec/MCP
   * regardless of permission mode (read/search still allowed).
   */
  getTrust?: () => TrustDecision;
  /**
   * Policy for write/edit when untrusted.
   * Default: ask when interactive, deny for `-p`.
   */
  untrustedWritePolicy?: HighRiskPolicy;
  /**
   * Policy for exec/network/MCP when untrusted.
   * Default: ask when interactive, deny for `-p`.
   */
  untrustedHighRiskPolicy?: HighRiskPolicy;
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

  const resolveUntrustedWrite = (): HighRiskPolicy => {
    if (options.untrustedWritePolicy) return options.untrustedWritePolicy;
    return interactiveSession ? "ask" : "deny";
  };

  const resolveUntrustedHighRisk = (): HighRiskPolicy => {
    if (options.untrustedHighRiskPolicy) return options.untrustedHighRiskPolicy;
    return interactiveSession ? "ask" : "deny";
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

    const trust = options.getTrust?.() ?? "trusted";
    if (!allowsProjectResources(trust)) {
      const trustBlock = await enforceUntrustedTool({
        name,
        approved,
        writePolicy: resolveUntrustedWrite(),
        highRiskPolicy: resolveUntrustedHighRisk(),
        interactive: options.interactive,
        sink: options.sink,
      });
      if (trustBlock) return trustBlock;
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

/** Tools restricted when the project is untrusted (read/search remain allowed). */
export function toolNeedsTrustGate(name: string): boolean {
  if (name.startsWith("mcp__")) return true;
  const risk = toolRisk(name);
  return risk === "write" || risk === "exec" || risk === "network" || risk === "merge";
}

async function enforceUntrustedTool(input: Readonly<{
  name: string;
  approved: Set<string>;
  writePolicy: HighRiskPolicy;
  highRiskPolicy: HighRiskPolicy;
  interactive: InteractiveIO;
  sink: SessionUiSink;
}>): Promise<{ block: true; reason: string } | undefined> {
  if (!toolNeedsTrustGate(input.name)) {
    return undefined;
  }

  const risk = toolRisk(input.name) ?? (input.name.startsWith("mcp__") ? "exec" : "write");
  const isWrite = risk === "write";
  const policy = isWrite ? input.writePolicy : input.highRiskPolicy;
  const approvalKey = `trust:${input.name}`;

  if (input.approved.has(approvalKey) || input.approved.has(input.name)) {
    return undefined;
  }

  if (policy === "allow") {
    input.approved.add(approvalKey);
    return undefined;
  }

  if (policy === "deny") {
    return {
      block: true,
      reason:
        `tool blocked: project is untrusted (${input.name}, ${risk}). `
        + "Trust this directory (interactive prompt / [trust] mode = trust) or use read-only tools.",
    };
  }

  const ok = await input.interactive.ask(
    `Untrusted project: allow ${risk} tool "${input.name}" for this session? [y/N] `,
    `tool: ${input.name}\nrisk: ${risk}\ntrust: untrusted\nscope: session`,
  );
  if (!ok) {
    return {
      block: true,
      reason: `user denied untrusted-project tool: ${input.name} (${risk})`,
    };
  }
  input.approved.add(approvalKey);
  input.sink.notify?.(
    `Approved ${input.name} (${risk}) for this untrusted session.`,
    "warning",
  );
  return undefined;
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
