/**
 * User-facing text for kernel recovery. Pure formatting (no kernel import), so
 * the session layer can render it on any runtime.
 */

import { adjudicationHint } from "./kernel-hint.ts";

type RecoveredOperation = Readonly<{ opId: string; action: string; resourcesReleased: boolean }>;

const ACTION_LABEL: Readonly<Record<string, string>> = {
  cleaned_unspawned: "never started",
  stopped_alive_process: "was still running — stopped",
  marked_dead: "had already exited",
  isolated_indeterminate: "could not be confirmed stopped — lease kept",
};

/** What recovery did with the previous launch's leftovers in this session's domain. */
export function formatSessionRecoveryNotice(
  recovered: readonly RecoveredOperation[],
  domainPath: string,
): string | undefined {
  if (recovered.length === 0) return undefined;
  const lines = [
    `Recovered ${recovered.length} operation(s) the previous launch of this session left unfinished:`,
    ...recovered.map((op) => describe(op, domainPath)),
  ];
  return lines.join("\n");
}

/** Crashed domains of other sessions that were adopted and recovered at startup. */
export function formatOrphanRecoveryNotice(
  orphans: readonly Readonly<{
    domainPath: string;
    sameWorkspace: boolean;
    recovered: readonly RecoveredOperation[];
    error?: string;
  }>[],
): string | undefined {
  const relevant = orphans.filter((orphan) => orphan.recovered.length > 0 || orphan.error);
  if (relevant.length === 0) return undefined;
  const lines: string[] = [];
  for (const orphan of relevant) {
    const where = orphan.sameWorkspace ? "a crashed session in this workspace" : "a crashed session";
    if (orphan.error) {
      lines.push(`Could not recover ${where} (${orphan.domainPath}): ${orphan.error}`);
      continue;
    }
    lines.push(`Recovered ${orphan.recovered.length} operation(s) from ${where} (${orphan.domainPath}):`);
    lines.push(...orphan.recovered.map((op) => describe(op, orphan.domainPath, true)));
  }
  return lines.join("\n");
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
