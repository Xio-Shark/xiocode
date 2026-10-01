/**
 * Session-layer glue for the kernel session: binding at session start,
 * recovery notices, Run-per-turn hooks, resume facts and the `/kernel` command.
 *
 * Every kernel failure here is reported through the UI sink. The session keeps
 * working without a kernel session, but the user is told what is off.
 */

import os from "node:os";

import {
  bindKernelSession,
  formatOrphanRecoveryNotice,
  formatSessionRecoveryNotice,
  kernelDomainRoot,
  resolveProcessBackend,
  sweepOrphanedDomains,
  type KernelAcceptance,
  type KernelSession,
  type KernelTurnOutcome,
} from "./process/index.ts";
import { INTERRUPTED_TOOL_PREFIX } from "./session-recovery.ts";
import type { AuthorizationFact } from "./tool-permission.ts";
import type { ExtensionHost } from "./extension-host.ts";
import type { ChatMessage } from "./types.ts";

type Notify = (message: string, level: "info" | "warning") => void;

export async function openSessionKernel(input: Readonly<{
  sessionId: string;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
  notify: Notify;
}>): Promise<KernelSession | undefined> {
  let session: KernelSession;
  try {
    session = await bindKernelSession(input);
  } catch (error) {
    input.notify(
      `Kernel session unavailable (${errorText(error)}): direct-mode /rollback and the kernel `
        + "journal are off for this session; commands and MCP servers run without the kernel.",
      "warning",
    );
    return undefined;
  }
  const recovered = session.recoveryReport?.recoveredOperations ?? [];
  const notice = formatSessionRecoveryNotice(recovered, session.domainPath);
  if (notice) {
    input.notify(notice, recovered.every((op) => op.resourcesReleased) ? "info" : "warning");
  }
  if (input.env.XIOCODE_KERNEL_CONFINE === "1") {
    try {
      input.notify(setConfinement(session, true, input.env), "info");
    } catch (error) {
      input.notify(`XIOCODE_KERNEL_CONFINE=1 but confinement is off: ${errorText(error)}`, "warning");
    }
  }
  void sweepOrphanedDomains({
    root: kernelDomainRoot(input.env),
    workspaceRoot: session.workspaceRoot,
    exclude: session.domainPath,
  }).then((orphans) => {
    const text = formatOrphanRecoveryNotice(orphans);
    if (text) input.notify(text, "warning");
  }, (error: unknown) => {
    input.notify(`Kernel recovery sweep failed: ${errorText(error)}`, "warning");
  });
  return session;
}

export type KernelTurnHooks = Readonly<{
  begin: (turnId: string) => void;
  end: (outcome: KernelTurnOutcome) => void;
}>;

/** Run-per-turn: the kernel refusing to open or close a Run is shown, never swallowed. */
export function createKernelTurnHooks(session: KernelSession, notify: Notify): KernelTurnHooks {
  let open = false;
  return {
    begin: (turnId) => {
      try {
        session.beginTurn(turnId);
        open = true;
      } catch (error) {
        notify(`Kernel could not open a Run for this turn: ${errorText(error)}`, "warning");
      }
    },
    end: (outcome) => {
      if (!open) return;
      open = false;
      try {
        const ended = session.endTurn(outcome);
        if (ended?.status === "indeterminate") {
          notify(
            `Kernel marked this turn's Run ${ended.runId} indeterminate: a process it started could not `
              + "be confirmed stopped. /kernel lists it.",
            "warning",
          );
        }
      } catch (error) {
        notify(`Kernel refused to close this turn's Run: ${errorText(error)}`, "warning");
      }
    },
  };
}

export function toKernelAcceptance(result: Readonly<{
  passed: boolean;
  summary: string;
  results: readonly Readonly<{ name: string; exitCode: number; passed: boolean }>[];
}>): KernelAcceptance {
  return {
    passed: result.passed,
    summary: result.summary,
    commands: result.results.map(({ name, exitCode, passed }) => ({ name, exitCode, passed })),
  };
}

/**
 * Resume: a tool call cut off by a crash was recorded as "completion unknown".
 * When the kernel has facts for its operation, say what actually happened.
 */
export function annotateInterruptedTools(
  messages: readonly ChatMessage[],
  session: KernelSession,
  env: NodeJS.ProcessEnv = process.env,
): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool" || !message.toolCallId) return message;
    if (!message.content.startsWith(INTERRUPTED_TOOL_PREFIX)) return message;
    const fact = session.getOperationByKey(message.toolCallId);
    if (!fact) {
      // Only when commands run through the kernel does a missing record prove
      // anything: with the built-in executor the kernel never sees them.
      const viaKernel = resolveProcessBackend(env).backend === "kernel";
      return {
        ...message,
        content: viaKernel
          ? `${message.content}\nkernel: no process was registered for this call, so it never started.`
          : `${message.content}\nkernel: commands are not running through the kernel, so it has no record of `
            + "this call: the command may have started, and a process it started may still be running.",
      };
    }
    return { ...message, content: `${message.content}\n${describeFact(fact)}` };
  });
}

function describeFact(fact: NonNullable<ReturnType<KernelSession["getOperationByKey"]>>): string {
  const result = fact.result;
  if (fact.status !== "done" || !result) {
    return `kernel: operation ${fact.opId} is ${fact.status}; recovery has not settled it.`;
  }
  if (result.status === "indeterminate") {
    return `kernel: operation ${fact.opId} is indeterminate (process not confirmed stopped). `
      + `Run /kernel adjudicate ${fact.opId} after inspecting it.`;
  }
  if (result.kind === "process" && result.terminationReason === "exit_unobserved") {
    return `kernel: operation ${fact.opId} ran and exited while XioCode was down; its exit was never `
      + "observed, so it may have succeeded or failed. Check its effects before running it again.";
  }
  if (result.kind === "process" && result.status === "cancelled" && result.evidence === "unobserved") {
    // Recovery found the process alive and stopped it: it did not finish.
    return `kernel: operation ${fact.opId} was still running when XioCode came back, and recovery stopped it. `
      + "It did not finish; whatever it had already done stays done. Check its effects before running it again.";
  }
  if (result.kind === "process") {
    const tail = result.stdout.slice(-2_000);
    return [
      `kernel: the process finished before the interruption (status=${result.status}, exit=${String(result.exitCode)}).`,
      tail.length > 0 ? `recorded stdout (tail):\n${tail}` : "recorded stdout: (empty)",
    ].join("\n");
  }
  return `kernel: operation ${fact.opId} finished with status ${result.status}.`;
}

/**
 * Authorization ledger: permission-gate decisions go to the kernel journal of
 * the current Run. A journal write failure is shown once, not per decision.
 */
export function createAuthorizationRecorder(
  session: KernelSession,
  notify: Notify,
): (fact: AuthorizationFact) => void {
  let reported = false;
  return (fact) => {
    try {
      session.recordFact("XIOCODE_AUTHORIZATION", { ...fact });
    } catch (error) {
      if (reported) return;
      reported = true;
      notify(`Kernel journal rejected an authorization record: ${errorText(error)}`, "warning");
    }
  };
}

/** `/kernel` — status of this session's domain; `/kernel adjudicate <opId> [verdict] [note]`. */
export function registerKernelCommand(host: ExtensionHost, getSession: () => KernelSession | undefined): void {
  host.registerCommand("kernel", {
    description: "Kernel domain status; /kernel adjudicate <opId> resolves an indeterminate operation.",
    handler: async (args) => {
      const session = getSession();
      if (!session) return "Kernel session is not available in this session.";
      const [sub, opId, verdictArg, ...noteParts] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      if (sub === "adjudicate") {
        if (!opId) return "usage: /kernel adjudicate <opId> [confirmed_stopped|abandon_with_residuals] [note]";
        const verdict = verdictArg === "abandon_with_residuals" ? "abandon_with_residuals" : "confirmed_stopped";
        const record = await session.adjudicate(opId, verdict, actorName(), noteParts.join(" ") || undefined);
        const residual = record.residualPids && record.residualPids.length > 0
          ? ` residual pids: ${record.residualPids.join(", ")}`
          : "";
        return `Adjudicated ${record.operationId}: ${record.verdict}.${residual}`;
      }
      return formatKernelStatus(session);
    },
  });
  host.registerCommand("confine", {
    description: "Write confinement for commands: /confine on|off (on lets /rollback be complete).",
    handler: async (args) => {
      const session = getSession();
      if (!session) return "Kernel session is not available in this session.";
      const arg = String(args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "off") return setConfinement(session, arg === "on");
      return session.confinement.enabled
        ? `Write confinement is on (${session.confinement.driver}). /confine off lifts it.`
        : "Write confinement is off. /confine on keeps commands inside the workspace.";
    },
  });
}

/**
 * Turns write confinement on or off and says what that means. Refused when
 * commands bypass the kernel (`XIOCODE_PROCESS_KERNEL=0`): the kernel could
 * not see them, so confinement would prove nothing.
 */
export function setConfinement(session: KernelSession, on: boolean, env: NodeJS.ProcessEnv = process.env): string {
  if (!on) {
    session.disableConfinement(actorName());
    return "Write confinement is off: commands can write anywhere again, so rollbacks cannot be vouched for as complete.";
  }
  const backend = resolveProcessBackend(env);
  if (backend.backend !== "kernel") {
    throw new Error(`commands are not run by the kernel (${backend.reason}), so it cannot confine them`);
  }
  const driver = session.enableConfinement(actorName());
  return [
    `Write confinement is on (${driver}): commands can only write inside ${session.workspaceRoot}`,
    "and only run from inside it. Tools that write elsewhere (caches, /tmp) will fail and say so.",
    "While nothing else runs unconfined (e.g. an MCP server), /rollback can restore the workspace completely.",
  ].join("\n");
}

function formatKernelStatus(session: KernelSession): string {
  const status = session.status();
  const indeterminate = status.operations.filter((op) => op.result?.status === "indeterminate");
  const lines = [
    `domain: ${session.domainPath}`,
    `driver: ${session.driver.name} (${session.driver.reason})`,
    `confinement: ${session.confinement.enabled ? `on (${session.confinement.driver})` : "off (/confine on)"}`,
    `run: ${session.currentRunId}  (runs: ${status.runs.length}, active: ${status.activeRuns.length})`,
    `operations: ${status.operations.length}, unfinished: ${status.unfinishedOperations.length}`,
    `leases: ${status.leases.length === 0 ? "none" : status.leases.map((lease) => `${lease.resourceId} ← ${session.describeOperation(lease.operationId)}`).join("; ")}`,
  ];
  if (indeterminate.length > 0) {
    lines.push("indeterminate (lease kept until adjudicated):");
    lines.push(...indeterminate.map((op) => `  ${op.id} (${op.name}) → /kernel adjudicate ${op.id}`));
  }
  return lines.join("\n");
}

function actorName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? "operator";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
