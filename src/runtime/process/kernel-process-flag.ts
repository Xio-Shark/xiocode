/**
 * Feature-flag resolution for the kernel process path.
 *
 * Kept in its own module (no `@xioflow/kernel` import) so the CLI can resolve
 * the flag on Node < 22.5 without ever touching `node:sqlite`.
 */

export const KERNEL_PROCESS_FLAG = "XIOCODE_PROCESS_KERNEL";

/** `node:sqlite` (used by the kernel store) requires Node >= 22.5. */
const MIN_KERNEL_NODE = [22, 5] as const;

export type KernelProcessFlag = Readonly<{
  enabled: boolean;
  reason: string;
}>;

/**
 * Disabled by default; the caller decides what to do with `reason` (log it,
 * never silently fake a fallback).
 */
export function kernelProcessFlag(
  env: NodeJS.ProcessEnv = process.env,
): KernelProcessFlag {
  const raw = (env[KERNEL_PROCESS_FLAG] ?? "").trim().toLowerCase();
  if (raw !== "1" && raw !== "true" && raw !== "on" && raw !== "yes") {
    return { enabled: false, reason: `${KERNEL_PROCESS_FLAG} is not enabled` };
  }
  if (process.platform === "win32") {
    return { enabled: false, reason: "xioflow kernel has no Windows process containment" };
  }
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (major < MIN_KERNEL_NODE[0] || (major === MIN_KERNEL_NODE[0] && minor < MIN_KERNEL_NODE[1])) {
    return {
      enabled: false,
      reason: `node ${process.versions.node} is older than 22.5 (node:sqlite is required)`,
    };
  }
  return { enabled: true, reason: "kernel process path enabled" };
}
