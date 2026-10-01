import fs from "node:fs";
import path from "node:path";

import { adjudicationHint } from "./kernel-hint.ts";

export type RecoveredOperation = Readonly<{ opId: string; action: string; resourcesReleased: boolean }>;

export type ExitReason = "signal" | "crash" | "unknown";

export type ExitReasonInfo = Readonly<{
  reason: ExitReason;
  signal?: string;
}>;

export type SessionRecoveryNotice = Readonly<{
  summary: string;
  detail: string;
  indeterminateCount: number;
  hasIndeterminate: boolean;
  toString: () => string;
}>;

const ACTION_LABEL: Readonly<Record<string, string>> = {
  cleaned_unspawned: "never started",
  stopped_alive_process: "was still running — stopped",
  marked_dead: "had already exited",
  isolated_indeterminate: "could not be confirmed stopped — lease kept",
};

export function recordSignalExit(domainPath: string, signal: string): void {
  try {
    const filePath = path.join(domainPath, "exit-reason.json");
    fs.writeFileSync(filePath, JSON.stringify({
      reason: "signal",
      signal,
      timestamp: new Date().toISOString(),
    }));
  } catch {
    // Best effort write
  }
}

export function readAndClearExitReason(domainPath: string): ExitReasonInfo {
  try {
    const filePath = path.join(domainPath, "exit-reason.json");
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best effort unlink
      }
      const parsed = JSON.parse(content) as { reason?: unknown; signal?: unknown };
      if (parsed.reason === "signal") {
        return {
          reason: "signal",
          signal: typeof parsed.signal === "string" ? parsed.signal : "SIGTERM",
        };
      }
      if (parsed.reason === "crash") {
        return { reason: "crash" };
      }
    }
  } catch {
    // Fall back to unknown
  }
  return { reason: "unknown" };
}

/** What recovery did with the previous launch's leftovers in this session's domain. */
export function formatSessionRecoveryNotice(
  recovered: readonly RecoveredOperation[],
  domainPath: string,
  options?: Readonly<{ exitReason?: ExitReason; signal?: string }>,
): SessionRecoveryNotice | undefined {
  if (recovered.length === 0) return undefined;

  const released = recovered.filter((op) => op.resourcesReleased);
  const indeterminate = recovered.filter((op) => !op.resourcesReleased);
  const releasedCount = released.length;
  const indeterminateCount = indeterminate.length;

  let reasonPrefix: string;
  if (options?.exitReason === "signal") {
    const sigStr = options.signal ? `（${options.signal}）` : "";
    reasonPrefix = `上次会话收到终止信号${sigStr}`;
  } else if (options?.exitReason === "crash") {
    reasonPrefix = "上次会话异常退出";
  } else {
    reasonPrefix = "上次会话未正常结束";
  }

  let summary: string;
  if (indeterminateCount === 0) {
    summary = `${reasonPrefix}，已清理 ${recovered.length} 个残留进程 · 详情 \`xio kernel status\``;
  } else if (releasedCount > 0) {
    summary = [
      `${reasonPrefix}，已清理 ${releasedCount} 个残留进程 · 详情 \`xio kernel status\``,
      `发现 ${indeterminateCount} 个残留进程无法确认状态（已隔离）· 详情 /kernel adjudicate`,
    ].join("\n");
  } else {
    summary = `发现 ${indeterminateCount} 个残留进程无法确认状态（已隔离）· 详情 /kernel adjudicate`;
  }

  const lines = [
    `Recovered ${recovered.length} operation(s) the previous launch of this session left unfinished:`,
    ...recovered.map((op) => describe(op, domainPath)),
  ];
  const detail = lines.join("\n");

  return {
    summary,
    detail,
    indeterminateCount,
    hasIndeterminate: indeterminateCount > 0,
    toString: () => detail,
  };
}

/** Orphaned domains of other sessions that were adopted and recovered at startup. */
export function formatOrphanRecoveryNotice(
  orphans: readonly Readonly<{
    domainPath: string;
    sameWorkspace: boolean;
    recovered: readonly RecoveredOperation[];
    error?: string;
    exitReason?: ExitReason;
    signal?: string;
  }>[],
): SessionRecoveryNotice | undefined {
  const relevant = orphans.filter((orphan) => orphan.recovered.length > 0 || orphan.error);
  if (relevant.length === 0) return undefined;

  const totalRecovered = relevant.reduce((sum, o) => sum + o.recovered.length, 0);
  const totalIndeterminate = relevant.reduce(
    (sum, o) => sum + o.recovered.filter((op) => !op.resourcesReleased).length,
    0,
  );
  const totalReleased = totalRecovered - totalIndeterminate;
  const errorCount = relevant.filter((o) => Boolean(o.error)).length;

  let summary: string;
  if (totalIndeterminate === 0 && errorCount === 0) {
    summary = `已清理外部会话的 ${totalRecovered} 个残留进程 · 详情 \`xio kernel status\``;
  } else if (totalReleased > 0) {
    summary = [
      `已清理外部会话的 ${totalReleased} 个残留进程 · 详情 \`xio kernel status\``,
      `发现 ${totalIndeterminate} 个残留进程无法确认状态（已隔离）· 详情 \`xio kernel status\``,
    ].join("\n");
  } else {
    summary = `发现 ${totalIndeterminate} 个残留进程无法确认状态（已隔离）· 详情 \`xio kernel status\``;
  }

  const lines: string[] = [];
  for (const orphan of relevant) {
    const where = orphan.sameWorkspace ? "a prior session in this workspace" : "a prior session";
    if (orphan.error) {
      lines.push(`Could not recover ${where} (${orphan.domainPath}): ${orphan.error}`);
      continue;
    }
    lines.push(`Recovered ${orphan.recovered.length} operation(s) from ${where} (${orphan.domainPath}):`);
    lines.push(...orphan.recovered.map((op) => describe(op, orphan.domainPath, true)));
  }
  const detail = lines.join("\n");

  return {
    summary,
    detail,
    indeterminateCount: totalIndeterminate,
    hasIndeterminate: totalIndeterminate > 0 || errorCount > 0,
    toString: () => detail,
  };
}

function describe(op: RecoveredOperation, domainPath: string, foreignDomain = false): string {
  const label = ACTION_LABEL[op.action] ?? op.action;
  const line = `  ${op.opId}: ${label}`;
  if (op.resourcesReleased) return line;
  const hint = foreignDomain
    ? `inspect the process, then run \`xio kernel adjudicate ${op.opId} --domain ${domainPath}\``
    : adjudicationHint(op.opId, domainPath);
  return `${line}; ${hint}`;
}
