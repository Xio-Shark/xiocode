import {
  isToolAllowedInMode,
  type PermissionMode,
} from "./permission-mode.ts";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { toolNeedsHighRiskGate, toolRisk } from "./tool-risk.ts";
import {
  classifyCommandExecution,
  commandFromToolArgs,
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
import type { InteractiveIO, SelectChoice } from "./interactive-io.ts";
import { t } from "../i18n/messages.ts";
import type { SessionUiSink } from "./session-ui.ts";

/** How to treat high-risk (exec/network) tools under auto mode. */
export type HighRiskPolicy = "ask" | "deny" | "allow";

/** Status field: bash auto-runs only proven-safe allowlist commands. */
export const SHELL_COMMAND_POLICY = "safe_allowlist_else_confirm" as const;

/**
 * One authorization decision, for the kernel journal. The subject (command
 * text, path) is only kept as a fingerprint: approvals must be auditable
 * without copying secrets that may sit in a command line.
 */
export type AuthorizationFact = Readonly<{
  gate: "mode" | "trust" | "path" | "tool" | "command";
  tool: string;
  decision: "allow" | "deny";
  /** `user` answered a prompt; `policy` is mode/config; `noninteractive` is a `-p` refusal. */
  by: "user" | "policy" | "noninteractive";
  scope: "call" | "session";
  mode: PermissionMode;
  toolCallId?: string;
  /** Risk id / reason, never raw command text. */
  detail?: string;
  subjectFingerprint?: string;
}>;

export type ToolPermissionGateOptions = Readonly<{
  host: ExtensionHost;
  /** Receives every approval/denial (not cache hits or proven-safe auto-runs). */
  recordDecision?: (fact: AuthorizationFact) => void;
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
   * Approvals are never cached across calls or promoted by full mode.
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
    const callId = toolCallIdFromEvent(record);
    const note: DecisionRecorder = (fact) => {
      options.recordDecision?.({ ...fact, tool: name, mode, ...(callId ? { toolCallId: callId } : {}) });
    };
    if (!isToolAllowedInMode(name, mode)) {
      note({ gate: "mode", decision: "deny", by: "policy", scope: "call" });
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
        note,
        callArgs: toolArgsFromEvent(record),
      });
      if (trustBlock) return trustBlock;
    }

    const pathBlock = await enforceExternalPathAccess({
      name,
      args: toolArgsFromEvent(record),
      callId,
      pathPolicy: options.pathPolicy,
      interactiveSession,
      interactive: options.interactive,
      sink: options.sink,
      note,
    });
    if (pathBlock) return pathBlock;

    // Tool-level high-risk (bash/MCP session approval) before command-level.
    if (toolNeedsHighRiskGate(name) && !approved.has(name)) {
      const risk = toolRisk(name) ?? "exec";
      const policy = resolvePolicy();

      if (policy === "allow") {
        approved.add(name);
        note({ gate: "tool", decision: "allow", by: "policy", scope: "session", detail: risk });
        options.sink.notify?.(
          t("approve.autoAllowed", { name, risk }),
          "warning",
        );
      } else if (policy === "deny") {
        note({ gate: "tool", decision: "deny", by: interactiveSession ? "policy" : "noninteractive", scope: "call", detail: risk });
        return {
          block: true,
          reason:
            `high-risk tool denied: ${name} (${risk}). Switch to full permission (Shift+Tab) `
            + "or pass --allow-high-risk / [permissions] allow_high_risk = true.",
        };
      } else if (name !== "bash") {
        // bash is gated per command below, with the command shown; a session-wide
        // "allow bash" would only ever cover the read-only allowlist.
        const answer = await askPermission(
          options.interactive,
          t("approve.tool", { risk, name }),
          describeCallArgs(toolArgsFromEvent(record)),
          { label: t("approve.session", { name }), scope: t("approve.sessionScope", { name }) },
        );
        if (!answer.allow) {
          note({ gate: "tool", decision: "deny", by: "user", scope: "call", detail: risk });
          return {
            block: true,
            reason: withFeedback(`user denied high-risk tool: ${name} (${risk})`, answer.feedback),
          };
        }
        note({ gate: "tool", decision: "allow", by: "user", scope: answer.scope, detail: risk });
        if (answer.scope === "session") {
          approved.add(name);
          options.sink.notify?.(t("approve.sessionGranted", { name, risk }), "info");
        }
      }
    }

    // Command-level: session bash approval never carries over to unproven shell.
    // full / allowHighRisk auto-allow the bash *tool*, not unsafe command text.
    const commandBlock = await enforceCommandExecution({
      name,
      args: toolArgsFromEvent(record),
      interactiveSession,
      interactive: options.interactive,
      sink: options.sink,
      note,
    });
    if (commandBlock) return commandBlock;
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
  note: DecisionRecorder;
  callArgs?: unknown;
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
    input.note({ gate: "trust", decision: "allow", by: "policy", scope: "session", detail: risk });
    return undefined;
  }

  if (policy === "deny") {
    input.note({ gate: "trust", decision: "deny", by: "policy", scope: "call", detail: risk });
    return {
      block: true,
      reason:
        `tool blocked: project is untrusted (${input.name}, ${risk}). `
        + "Trust this directory (interactive prompt / [trust] mode = trust) or use read-only tools.",
    };
  }

  const ok = await input.interactive.ask(
    t("approve.untrustedTool", { risk, name: input.name }),
    `tool: ${input.name}\nrisk: ${risk}\ntrust: untrusted\nscope: session\nthis call: ${describeCallArgs(input.callArgs)}`,
  );
  if (!ok) {
    input.note({ gate: "trust", decision: "deny", by: "user", scope: "call", detail: risk });
    return {
      block: true,
      reason: `user denied untrusted-project tool: ${input.name} (${risk})`,
    };
  }
  input.note({ gate: "trust", decision: "allow", by: "user", scope: "session", detail: risk });
  input.approved.add(approvalKey);
  input.sink.notify?.(
    t("approve.untrustedGranted", { name: input.name, risk }),
    "warning",
  );
  return undefined;
}

/**
 * Command-level gate for bash. Proven-safe allowlist auto-runs; everything else
 * asks once per raw command (interactive) or denies (non-interactive).
 * `full` / `--allow-high-risk` never auto-approve unproven shell text.
 */
async function enforceCommandExecution(input: Readonly<{
  name: string;
  args: unknown;
  interactiveSession: boolean;
  interactive: InteractiveIO;
  sink: SessionUiSink;
  note: DecisionRecorder;
}>): Promise<{ block: true; reason: string } | undefined> {
  if (input.name !== "bash") return undefined;
  const command = commandFromToolArgs(input.args);
  if (command === undefined) {
    // Missing command string — fail closed at command layer.
    if (!input.interactiveSession) {
      input.note({ gate: "command", decision: "deny", by: "noninteractive", scope: "call", detail: "missing-command" });
      return {
        block: true,
        reason: "bash command missing; requires interactive one-time approval.",
      };
    }
    return undefined;
  }

  // `~` is an expansion, not a literal: expand it with the real home so allowlist
  // matching sees the path the shell would run (`ls ~/x` was rejected as complex-shell).
  const decision = classifyCommandExecution(command, homedir());
  if (decision.kind === "safe") {
    return undefined;
  }

  const riskBit = decision.risk
    ? `${decision.risk.severity}/${decision.risk.id}`
    : decision.reason;
  const subjectFingerprint = fingerprint(command);
  if (!input.interactiveSession) {
    input.note({ gate: "command", decision: "deny", by: "noninteractive", scope: "call", detail: riskBit, subjectFingerprint });
    return {
      block: true,
      reason:
        `command blocked (${riskBit}): requires interactive one-time approval. `
        + "Unsafe/complex shell is never auto-allowed by --allow-high-risk or full mode.",
    };
  }

  const question = decision.reason === "known-risk" && decision.risk
    ? t("approve.riskCommand", { severity: decision.risk.severity })
    : decision.reason === "complex-shell"
      ? t("approve.complexCommand")
      : t("approve.command");

  // Unproven shell is approved one call at a time: no session choice, ever.
  const answer = await askPermission(input.interactive, question, decision.detail);
  input.note({
    gate: "command",
    decision: answer.allow ? "allow" : "deny",
    by: "user",
    scope: "call",
    detail: riskBit,
    subjectFingerprint,
  });
  if (!answer.allow) {
    return {
      block: true,
      reason: withFeedback(decision.risk
        ? `user denied command (${decision.risk.id}): ${decision.risk.match}`
        : `user denied command (${decision.reason})`, answer.feedback),
    };
  }
  input.sink.notify?.(
    decision.risk
      ? t("approve.onceRisk", { match: decision.risk.match, severity: decision.risk.severity })
      : t("approve.onceReason", { reason: decision.reason }),
    "warning",
  );
  return undefined;
}

/**
 * Exact one-tool-call grant for lexical outside read/search paths.
 * Never session-cached; never opened by high-risk allow / full mode.
 */
async function enforceExternalPathAccess(input: Readonly<{
  name: string;
  args: unknown;
  callId: string | undefined;
  pathPolicy: WorkspacePathPolicy | undefined;
  interactiveSession: boolean;
  interactive: InteractiveIO;
  sink: SessionUiSink;
  note: DecisionRecorder;
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

  const subjectFingerprint = fingerprint(decision.request.canonicalPath);
  if (!input.interactiveSession) {
    input.note({ gate: "path", decision: "deny", by: "noninteractive", scope: "call", detail: operation, subjectFingerprint });
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

  const answer = await askPermission(
    input.interactive,
    t("approve.outside", { name: input.name, operation }),
    [
      `tool: ${input.name}`,
      `operation: ${operation}`,
      `requested: ${decision.request.requestedPath}`,
      `canonical: ${decision.request.canonicalPath}`,
    ].join("\n"),
  );
  input.note({ gate: "path", decision: answer.allow ? "allow" : "deny", by: "user", scope: "call", detail: operation, subjectFingerprint });
  if (!answer.allow) {
    return {
      block: true,
      reason: withFeedback(`user denied outside path: ${decision.request.canonicalPath}`, answer.feedback),
    };
  }
  input.pathPolicy.grantOnce(input.callId, decision.request);
  input.sink.notify?.(
    t("approve.outsideGranted", { operation, name: input.name, id: input.callId }),
    "warning",
  );
  return undefined;
}

const DENY_WITH_REASON = "deny-reason";

type PermissionAnswer =
  | Readonly<{ allow: true; scope: "call" | "session" }>
  | Readonly<{ allow: false; feedback?: string }>;

/**
 * One approval question as a choice list: allow once, allow for the session (only when
 * `session` is given), deny, or deny and tell the model why. Cancelling (Esc) is a denial.
 */
async function askPermission(
  interactive: InteractiveIO,
  question: string,
  detail: string,
  session?: Readonly<{ label: string; scope: string }>,
): Promise<PermissionAnswer> {
  const choices: SelectChoice[] = [
    { label: t("approve.once"), value: "once", scope: t("approve.onceScope") },
    ...(session ? [{ label: session.label, value: "session", scope: session.scope }] : []),
    { label: t("approve.deny"), value: "deny" },
    { label: t("approve.denyReason"), value: DENY_WITH_REASON },
  ];
  const picked = await interactive.select(question, choices, detail);
  if (picked === "once") return { allow: true, scope: "call" };
  if (picked === "session" && session) return { allow: true, scope: "session" };
  if (picked !== DENY_WITH_REASON) return { allow: false };
  const feedback = (await interactive.prompt(t("approve.why")))?.trim();
  return feedback ? { allow: false, feedback } : { allow: false };
}

function withFeedback(reason: string, feedback: string | undefined): string {
  return feedback ? `${reason}. The user says: ${feedback}` : reason;
}

/** One-line view of a tool call's arguments for an approval question. */
function describeCallArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {});
  } catch {
    text = String(args);
  }
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

type DecisionRecorder = (
  fact: Omit<AuthorizationFact, "tool" | "mode" | "toolCallId">,
) => void;

function fingerprint(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 16);
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
