/**
 * Feature-gated process entry point used by the bash tool and the done
 * contract.
 *
 * - flag off (default): the legacy supervisor, byte-for-byte the old path
 * - flag on: `@xioflow/kernel` through `kernel-adapter.ts`
 *
 * The adapter is imported dynamically on purpose: it pulls in `node:sqlite`,
 * which does not exist on the Node versions the product still supports, so an
 * enabled flag on an old runtime must fail loudly at use time instead of
 * breaking every CLI start.
 */

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { kernelProcessFlag, type KernelProcessFlag } from "./kernel-process-flag.ts";
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
  return override && override.length > 0
    ? override
    : path.join(os.homedir(), ".xiocode", "kernel");
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
    return runSupervisedProcess(options);
  }
  const runner = await acquireKernelRunner(resolved.domainPath!);
  return runner.run(options);
}

export function resetKernelProcessRunnerForTests(): void {
  cachedRunner?.close();
  cachedRunner = undefined;
  cachedDomainPath = undefined;
}

let cachedRunner: KernelProcessRunner | undefined;
let cachedDomainPath: string | undefined;

async function acquireKernelRunner(domainPath: string): Promise<KernelProcessRunner> {
  if (cachedRunner && cachedDomainPath === domainPath) {
    return cachedRunner;
  }
  cachedRunner?.close();
  cachedRunner = undefined;
  const { KernelProcessRunner: Runner } = await import("./kernel-adapter.ts");
  const runner = new Runner({
    sessionId: sessionKeyFromDomainPath(domainPath),
    turnId: "cli",
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
