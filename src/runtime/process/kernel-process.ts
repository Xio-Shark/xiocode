/**
 * Process entry point used by the bash tool, the done contract, search
 * backends, plan dispatch and the sandbox's git plumbing — plus the owner of
 * the session's kernel binding.
 *
 * Two independent switches:
 * - The **kernel session** (domain, Task/Run, snapshots, journal facts) is
 *   bound by the session layer through `bindKernelSession` and is always on:
 *   it only needs `node:sqlite` and git.
 * - The **process executor** is the kernel by default. `XIOCODE_PROCESS_KERNEL=0`
 *   (or a runtime the kernel driver cannot serve) selects the built-in
 *   supervisor for command execution only — never silently.
 *
 * Kernel modules are imported dynamically: they pull in `node:sqlite`, and an
 * unsupported runtime must report the reason instead of crashing at CLI start.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveSensitiveLocalStatePaths } from "../private-fs.ts";
import {
  KERNEL_PROCESS_FLAG,
  kernelProcessFlag,
  type KernelProcessFlag,
} from "./kernel-process-flag.ts";
import {
  runSupervisedProcess,
  type ProcessRunOptions,
  type ProcessRunResult,
} from "./process-supervisor.ts";
import type { KernelSession } from "./kernel-session.ts";

export type ProcessBackend = Readonly<{
  backend: "kernel" | "legacy";
  reason: string;
}>;

/** Domain root; `XIOCODE_KERNEL_DOMAIN_ROOT` wins, else `<XIO_HOME>/kernel`. */
export function kernelDomainRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.XIOCODE_KERNEL_DOMAIN_ROOT?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return path.join(resolveSensitiveLocalStatePaths(env).xioHome, "kernel");
}

/**
 * `<root>/<workspace>-<workspace digest>-s<session digest>`: stable for a
 * session in a workspace, so a crashed launch leaves a domain the next launch
 * of the same session reopens (and the sweep can find by workspace).
 */
export function kernelDomainPath(root: string, workspaceRoot: string, sessionId: string): string {
  return path.join(root, `${workspacePrefix(workspaceRoot)}-s${digest(sessionId)}`);
}

function workspacePrefix(workspaceRoot: string): string {
  const base = path.basename(workspaceRoot).replace(/[^A-Za-z0-9._-]+/g, "-") || "workspace";
  return `${base}-${digest(workspaceRoot)}`;
}

function digest(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 10);
}

/** Which process executor a call would use right now, with the reason spelled out. */
export function resolveProcessBackend(env: NodeJS.ProcessEnv = process.env): ProcessBackend {
  const flag: KernelProcessFlag = kernelProcessFlag(env);
  return flag.enabled
    ? { backend: "kernel", reason: flag.reason }
    : { backend: "legacy", reason: flag.reason };
}

export type BindKernelSessionInput = Readonly<{
  sessionId: string;
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  /** See `KernelSessionOptions.ephemeral`. */
  ephemeral?: boolean;
}>;

let bound: Readonly<{ key: string; session: Promise<KernelSession> }> | undefined;

/**
 * Opens (once) the kernel session for this product session. A different
 * session id or workspace closes the previous binding first.
 */
export async function bindKernelSession(input: BindKernelSessionInput): Promise<KernelSession> {
  const workspaceRoot = realpathOr(path.resolve(input.workspaceRoot));
  const root = kernelDomainRoot(input.env);
  const domainPath = kernelDomainPath(root, workspaceRoot, input.sessionId);
  if (bound?.key === domainPath) {
    return bound.session;
  }
  await closeKernelSession();
  const { KernelSession: Session } = await import("./kernel-session.ts");
  const session = Session.open({
    sessionId: input.sessionId,
    workspaceRoot,
    domainPath,
    ephemeral: input.ephemeral === true,
  });
  bound = { key: domainPath, session };
  try {
    return await session;
  } catch (error) {
    if (bound?.session === session) bound = undefined;
    throw error;
  }
}

/** Closes the binding. Returns the kernel's refusal to close a Run, if any. */
export async function closeKernelSession(): Promise<Error | undefined> {
  const previous = bound;
  bound = undefined;
  if (!previous) return undefined;
  try {
    const session = await previous.session;
    return session.close();
  } catch {
    // Opening failed; the binder already reported it and there is nothing to close.
    return undefined;
  }
}

/**
 * Runs one supervised process. Kernel executor: through the bound session, or
 * an ephemeral one for callers outside a product session (`xio exec`, tools
 * used before binding). Legacy executor: the built-in supervisor.
 */
export async function runSupervisedProcessGated(
  options: ProcessRunOptions,
): Promise<ProcessRunResult> {
  const resolved = resolveProcessBackend();
  if (resolved.backend === "legacy") {
    if (kernelProcessFlag().source === "default") {
      notifyKernelFallback(resolved.reason);
    }
    return runSupervisedProcess(options);
  }
  let session: KernelSession;
  try {
    session = await resolveKernelSession(options.cwd);
  } catch (error) {
    notifyKernelFallback(`kernel session could not open: ${error instanceof Error ? error.message : String(error)}`);
    return runSupervisedProcess(options);
  }
  return session.run(options);
}

/**
 * The bound session, or an ephemeral one for callers outside a product
 * session. Throws when the domain cannot be opened; callers decide the fallback.
 */
export async function resolveKernelSession(cwd: string): Promise<KernelSession> {
  if (bound) return bound.session;
  return bindKernelSession({
    sessionId: `ephemeral-${launchToken}`,
    workspaceRoot: cwd,
    ephemeral: true,
  });
}

export function resetKernelProcessForTests(): void {
  const previous = bound;
  bound = undefined;
  void previous?.session.then((session) => session.close(), () => undefined);
  fallbackNotified = false;
}

/**
 * One line, once per process, when the kernel executor is the default but the
 * runtime cannot serve it. Never emitted when the caller asked for legacy.
 */
export function kernelFallbackNotice(reason: string): string {
  return `xiocode: kernel process executor unavailable (${reason}); using the built-in supervisor. `
    + `Set ${KERNEL_PROCESS_FLAG}=0 to silence this, or run Node 22.13+ for the kernel path.`;
}

export function notifyKernelFallback(
  reason: string,
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): boolean {
  if (fallbackNotified) {
    return false;
  }
  fallbackNotified = true;
  write(`${kernelFallbackNotice(reason)}\n`);
  return true;
}

let fallbackNotified = false;

const launchToken = crypto.randomBytes(3).toString("hex");

export type OrphanedDomainRecovery = Readonly<{
  domainPath: string;
  sameWorkspace: boolean;
  recovered: readonly Readonly<{ opId: string; action: string; resourcesReleased: boolean }>[];
  error?: string;
}>;

/**
 * Adopts domains whose owner died (the lock file outlives a crash; a clean
 * close removes it) and runs recovery on them, so what a crashed launch left
 * behind is adjudicated even when that session is never resumed. Live owners
 * are skipped by the kernel's own lock check.
 */
export async function sweepOrphanedDomains(input: Readonly<{
  root: string;
  workspaceRoot: string;
  exclude?: string;
}>): Promise<OrphanedDomainRecovery[]> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(input.root, { withFileTypes: true });
  } catch {
    return [];
  }
  const prefix = `${workspacePrefix(realpathOr(path.resolve(input.workspaceRoot)))}-`;
  const results: OrphanedDomainRecovery[] = [];
  const { recoverOrphanedDomain } = await import("./kernel-sweep.ts");
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const domainPath = path.join(input.root, entry.name);
    if (domainPath === input.exclude) continue;
    if (!fs.existsSync(path.join(domainPath, "domain.lock"))) continue;
    const outcome = await recoverOrphanedDomain(domainPath);
    if (!outcome) continue;
    results.push({ ...outcome, domainPath, sameWorkspace: entry.name.startsWith(prefix) });
  }
  return results;
}

/** Removes a deleted session's kernel domain (and its snapshot refs); see `disposeDomain`. */
export async function disposeSessionDomain(input: Readonly<{
  sessionId: string;
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<import("./kernel-sweep.ts").DisposeOutcome> {
  const workspaceRoot = realpathOr(path.resolve(input.workspaceRoot));
  const domainPath = kernelDomainPath(kernelDomainRoot(input.env), workspaceRoot, input.sessionId);
  const { disposeDomain } = await import("./kernel-sweep.ts");
  const { sanitizeId } = await import("./kernel-session.ts");
  return disposeDomain(domainPath, sanitizeId(input.sessionId));
}

function realpathOr(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}
