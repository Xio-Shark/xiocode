/**
 * Process entry point used by the bash tool, the done contract, search
 * backends and plan dispatch.
 *
 * - default: `@xioflow/kernel` through `kernel-adapter.ts`
 * - `XIOCODE_PROCESS_KERNEL=0`: the built-in supervisor (escape hatch)
 * - runtime without kernel support (Node < 22.5, Windows): built-in supervisor
 *   plus a one-line notice, never a silent fallback
 *
 * The adapter is imported dynamically on purpose: it pulls in `node:sqlite`,
 * which does not exist on the Node versions the product still supports, so an
 * unsupported runtime must report the reason instead of crashing at CLI start.
 */

import crypto from "node:crypto";
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
import type { KernelProcessRunner } from "./kernel-adapter.ts";

export type ProcessBackend = Readonly<{
  backend: "kernel" | "legacy";
  reason: string;
  domainPath?: string;
}>;

/** Domain root for the kernel path; tests and CI can point it at a temp dir. */
export function kernelDomainRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.XIOCODE_KERNEL_DOMAIN_ROOT?.trim();
  if (override && override.length > 0) {
    return override;
  }
  // Same home resolution as the rest of the product (XIO_HOME aware), so a
  // custom home keeps its kernel domains next to its sessions and spills.
  return path.join(resolveSensitiveLocalStatePaths(env).xioHome, "kernel");
}

let sessionOverride: string | undefined;

/**
 * Binds the kernel execution domain to the product session, so a crashed
 * process leaves a domain the next launch of the *same* session can adopt and
 * adjudicate with `RecoveryEngine`. Without a session id the domain falls back
 * to workspace + pid (still isolated, but not re-adoptable across restarts).
 */
export function setKernelProcessSession(sessionId: string | undefined): void {
  const next = sessionId?.trim() || undefined;
  if (next === sessionOverride) {
    return;
  }
  sessionOverride = next;
  resetKernelProcessRunnerForTests();
}

/** Which backend a call would use right now, with the reason spelled out. */
export function resolveProcessBackend(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ProcessBackend {
  const flag: KernelProcessFlag = kernelProcessFlag(env);
  if (!flag.enabled) {
    return { backend: "legacy", reason: flag.reason };
  }
  return {
    backend: "kernel",
    reason: flag.reason,
    domainPath: path.join(kernelDomainRoot(env), sessionKey(cwd)),
  };
}

/**
 * Runs one supervised process on the backend selected by the feature flag.
 * Callers keep the exact `ProcessRunOptions` → `ProcessRunResult` contract.
 */
export async function runSupervisedProcessGated(
  options: ProcessRunOptions,
): Promise<ProcessRunResult> {
  const resolved = resolveProcessBackend(options.cwd);
  if (resolved.backend === "legacy") {
    if (kernelProcessFlag().source === "default") {
      notifyKernelFallback(resolved.reason);
    }
    return runSupervisedProcess(options);
  }
  const runner = await acquireKernelRunner(resolved.domainPath!);
  return runner.run(options);
}

export function resetKernelProcessRunnerForTests(): void {
  cachedRunner?.close();
  cachedRunner = undefined;
  cachedDomainPath = undefined;
  fallbackNotified = false;
}

/**
 * One line, once per process, when the kernel path is the default but the
 * runtime cannot serve it. Never emitted when the caller asked for legacy.
 */
export function kernelFallbackNotice(reason: string): string {
  return `xiocode: kernel process layer unavailable (${reason}); using the built-in supervisor. `
    + `Set ${KERNEL_PROCESS_FLAG}=0 to silence this, or run Node 22.5+ for the kernel path.`;
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

let cachedRunner: KernelProcessRunner | undefined;
let cachedDomainPath: string | undefined;

/** One Run per launch: a restarted session opens a new Run in the same domain. */
const launchId = `cli-${crypto.randomBytes(3).toString("hex")}`;

async function acquireKernelRunner(domainPath: string): Promise<KernelProcessRunner> {
  if (cachedRunner && cachedDomainPath === domainPath) {
    return cachedRunner;
  }
  cachedRunner?.close();
  cachedRunner = undefined;
  const { KernelProcessRunner: Runner } = await import("./kernel-adapter.ts");
  const runner = new Runner({
    sessionId: sessionKeyFromDomainPath(domainPath),
    turnId: launchId,
    domainPath,
  });
  // Acquire eagerly so an unusable domain (locked, readonly, no node:sqlite)
  // fails here instead of on the first command.
  runner.ensureDomain();
  cachedRunner = runner;
  cachedDomainPath = domainPath;
  return runner;
}

/** One CLI process is one session: workspace hash + session id (or pid) keeps domains distinct. */
function sessionKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  const digest = crypto.createHash("sha1").update(resolved).digest("hex").slice(0, 10);
  const base = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, "-") || "workspace";
  const owner = sessionOverride
    ? `s${crypto.createHash("sha1").update(sessionOverride).digest("hex").slice(0, 10)}`
    : `p${process.pid}`;
  return `${base}-${digest}-${owner}`;
}

function sessionKeyFromDomainPath(domainPath: string): string {
  return path.basename(domainPath);
}
