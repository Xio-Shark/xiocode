/**
 * Recovery of a domain whose owner is gone. Kept apart from kernel-process.ts
 * because it imports `@xioflow/kernel` (node:sqlite) eagerly.
 */

import fs from "node:fs";
import path from "node:path";

import {
  DomainLockedError,
  ExecutionDomain,
  ProcessSupervisor,
  RecoveryEngine,
} from "@xioflow/kernel";

import { resolveKernelDriver } from "./kernel-driver.ts";

export type OrphanOutcome = Readonly<{
  recovered: readonly Readonly<{ opId: string; action: string; resourcesReleased: boolean }>[];
  error?: string;
}>;

/**
 * Returns `undefined` when the domain has a live owner (not ours to touch) or
 * nothing was left to recover; otherwise what recovery did, or why it failed.
 */
export async function recoverOrphanedDomain(domainPath: string): Promise<OrphanOutcome | undefined> {
  const lock = readLock(domainPath);
  if (!lock) {
    return { recovered: [], error: "domain.lock is unreadable; inspect the domain manually" };
  }
  // Only a dead owner is an orphan. The kernel would also take over a live
  // owner whose lease expired (e.g. right after the machine wakes from sleep),
  // which would fence a session that is still running.
  if (isAlive(lock.ownerPid)) return undefined;
  const domainId = lock.domainId;
  let domain: ExecutionDomain;
  try {
    domain = ExecutionDomain.acquire(domainPath, domainId);
  } catch (error) {
    if (error instanceof DomainLockedError) return undefined;
    return { recovered: [], error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const report = await new RecoveryEngine(domain, resolveKernelDriver().create()).recover();
    return report.recoveredOperations.length > 0
      ? { recovered: report.recoveredOperations }
      : undefined;
  } catch (error) {
    return { recovered: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    domain.close();
  }
}

export type DisposeOutcome =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "kept"; reason: string }>
  | Readonly<{ kind: "removed"; prunedSnapshots: number }>;

/**
 * Deleting a session: prune its snapshot refs from the repository, then remove
 * the domain. A domain with a lock file (live session or crash evidence) or
 * with unfinished / indeterminate work is kept.
 */
export async function disposeDomain(domainPath: string, domainId: string): Promise<DisposeOutcome> {
  if (!fs.existsSync(path.join(domainPath, "domain.db"))) return { kind: "absent" };
  if (fs.existsSync(path.join(domainPath, "domain.lock"))) {
    return { kind: "kept", reason: "the domain is locked (running session or crash not yet recovered)" };
  }
  const domain = ExecutionDomain.acquire(domainPath, domainId);
  let pruned: string[];
  try {
    const store = domain.getStore();
    const pending = store.getAllOperations(domain.domainId)
      .filter((op) => op.status !== "done" || op.result?.status === "indeterminate");
    if (pending.length > 0) {
      return { kind: "kept", reason: `${pending.length} operation(s) are unfinished or indeterminate` };
    }
    const supervisor = new ProcessSupervisor(domain, resolveKernelDriver().create());
    pruned = await supervisor.pruneSnapshots(store.listSnapshots(domain.domainId).map((snap) => snap.id));
  } finally {
    domain.close();
  }
  fs.rmSync(domainPath, { recursive: true, force: true });
  return { kind: "removed", prunedSnapshots: pruned.length };
}

function readLock(domainPath: string): Readonly<{ domainId: string; ownerPid: number }> | undefined {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(domainPath, "domain.lock"), "utf8")) as {
      domainId?: unknown;
      ownerPid?: unknown;
    };
    if (typeof meta.domainId !== "string" || meta.domainId.length === 0) return undefined;
    if (typeof meta.ownerPid !== "number" || !Number.isInteger(meta.ownerPid)) return undefined;
    return { domainId: meta.domainId, ownerPid: meta.ownerPid };
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
