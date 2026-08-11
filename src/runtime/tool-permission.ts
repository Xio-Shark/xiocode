import {
  isToolAllowedInMode,
  type PermissionMode,
} from "./permission-mode.ts";
import { toolNeedsHighRiskGate, toolRisk } from "./tool-risk.ts";
import {
  classifyCommandRisk,
  commandFromToolArgs,
  describeCommandRisk,
} from "./command-risk.ts";
import {
  allowsProjectResources,
  type TrustDecision,
} from "./project-trust.ts";
import {
  WorkspacePathError,
  type WorkspacePathPolicy,
} from "./workspace-path-policy.ts";

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
  /**
   * Session workspace path policy. When set, lexical outside read/search paths
   * may receive an exact one-tool-call grant (interactive only). Outside
   * write/edit, non-interactive sessions, and explore workers never get a grant.
   * Approvals are never cached across calls or promoted by `/bypass` / full mode.
   */
  pathPolicy?: WorkspacePathPolicy;
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

    const pathBlock = await enforceExternalPathAccess({
      name,
      args: toolArgsFromEvent(record),
      callId: toolCallIdFromEvent(record),
      pathPolicy: options.pathPolicy,
      interactiveSession,
      interactive: options.interactive,
      sink: options.sink,
    });
    if (pathBlock) return pathBlock;

    // Command-level layer: session tool approval does not carry over to the
    // commands that destroy data or run remote code. Re-asked every time.
    const commandBlock = await enforceCommandRisk({
      name,
      args: toolArgsFromEvent(record),
      policy: resolvePolicy(),
      interactive: options.interactive,
      sink: options.sink,
    });
    if (commandBlock) return commandBlock;

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

/**
 * Strong confirm for known-catastrophic shell commands. Runs beneath the tool
 * risk classes: an already-approved `bash` still stops here, because approving
 * "the agent may run commands" is not approving `rm -rf ~`.
 *
 * `full` / `/bypass` still auto-allow — the user opted into that explicitly —
 * but the match is announced so the action is never silent.
 */
async function enforceCommandRisk(input: Readonly<{
  name: string;
  args: unknown;
  policy: HighRiskPolicy;
  interactive: InteractiveIO;
  sink: SessionUiSink;
}>): Promise<{ block: true; reason: string } | undefined> {
  if (input.name !== "bash") return undefined;
  const command = commandFromToolArgs(input.args);
  if (!command) return undefined;
  const risk = classifyCommandRisk(command);
  if (!risk) return undefined;

  if (input.policy === "allow") {
    input.sink.notify?.(
      `Dangerous command auto-allowed (${risk.severity}): ${risk.match} — ${risk.reason}`,
      "warning",
    );
    return undefined;
  }

  if (input.policy === "deny") {
    return {
      block: true,
      reason:
        `dangerous command blocked (${risk.severity}/${risk.id}): ${risk.match}. ${risk.reason} `
        + "Run it yourself, or re-run with --allow-high-risk / full permission mode if you meant it.",
    };
  }

  const ok = await input.interactive.ask(
    `Run this ${risk.severity} command? [y/N] `,
    describeCommandRisk(risk, command),
  );
  if (!ok) {
    return {
      block: true,
      reason: `user denied dangerous command (${risk.id}): ${risk.match}`,
    };
  }
  input.sink.notify?.(`Approved once: ${risk.match} (${risk.severity}).`, "warning");
  return undefined;
}

/**
 * Exact one-tool-call grant for lexical outside read/search paths.
 * Never session-cached; never opened by high-risk allow / `/bypass`.
 */
async function enforceExternalPathAccess(input: Readonly<{
  name: string;
  args: unknown;
  callId: string | undefined;
  pathPolicy: WorkspacePathPolicy | undefined;
  interactiveSession: boolean;
  interactive: InteractiveIO;
  sink: SessionUiSink;
}>): Promise<{ block: true; reason: string } | undefined> {
  if (!input.pathPolicy) return undefined;
  const operation = pathOperationForTool(input.name);
  if (!operation) return undefined;
  const requestedPath = pathArgForTool(input.name, input.args);
  if (requestedPath === undefined) return undefined;

  let decision;
  try {
    decision = await input.pathPolicy.inspect(operation, requestedPath);
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      return { block: true, reason: error.message };
    }
    throw error;
  }
  if (decision.decision === "allow") {
    return undefined;
  }

  if (!input.interactiveSession) {
    return {
      block: true,
      reason:
        `outside path denied in non-interactive mode (${input.name}): `
        + decision.request.canonicalPath,
    };
  }
  if (!input.callId) {
    return {
      block: true,
      reason: `outside path requires a tool call id (${input.name})`,
    };
  }

  const ok = await input.interactive.ask(
    `Allow outside ${operation} for this tool call only? [y/N] `,
    [
      `tool: ${input.name}`,
      `operation: ${operation}`,
      `requested: ${decision.request.requestedPath}`,
      `canonical: ${decision.request.canonicalPath}`,
      "scope: this tool call only (not reusable)",
    ].join("\n"),
  );
  if (!ok) {
    return {
      block: true,
      reason: `user denied outside path: ${decision.request.canonicalPath}`,
    };
  }
  input.pathPolicy.grantOnce(input.callId, decision.request);
  input.sink.notify?.(
    `Granted outside ${operation} once for ${input.name} (${input.callId}).`,
    "warning",
  );
  return undefined;
}

function pathOperationForTool(name: string): "read-file" | "search" | undefined {
  if (name === "read") return "read-file";
  if (name === "grep" || name === "glob") return "search";
  return undefined;
}

function pathArgForTool(name: string, args: unknown): string | undefined {
  const record = asRecord(args);
  if (name === "read") {
    return typeof record?.path === "string" ? record.path : undefined;
  }
  if (name === "grep" || name === "glob") {
    return typeof record?.path === "string" ? record.path : ".";
  }
  return undefined;
}

function toolArgsFromEvent(record: Record<string, unknown> | undefined): unknown {
  if (!record) return undefined;
  const call = asRecord(record.call);
  if (call && call.args !== undefined) return call.args;
  return record.args;
}

function toolCallIdFromEvent(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  const call = asRecord(record.call);
  if (call && typeof call.id === "string" && call.id.length > 0) return call.id;
  if (typeof record.toolCallId === "string" && record.toolCallId.length > 0) {
    return record.toolCallId;
  }
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
