/**
 * Feature-flag resolution for the kernel process path.
 *
 * Kept in its own module (no `@xioflow/kernel` import) so the CLI can resolve
 * the flag on Node < 22.5 without ever touching `node:sqlite`.
 *
 * The kernel path is the default. `XIOCODE_PROCESS_KERNEL=0` (or `false`/`off`/
 * `no`) selects the built-in supervisor explicitly, which is the escape hatch
 * for one release after a regression, and the only path on runtimes the kernel
 * cannot serve.
 */

export const KERNEL_PROCESS_FLAG = "XIOCODE_PROCESS_KERNEL";

/** `node:sqlite` (used by the kernel store) requires Node >= 22.5. */
const MIN_KERNEL_NODE = [22, 5] as const;

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);
const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export type KernelProcessFlag = Readonly<{
  enabled: boolean;
  reason: string;
  /** `explicit` when the caller set the variable, `default` when nobody asked. */
  source: "default" | "explicit";
}>;

export function kernelProcessFlag(
  env: NodeJS.ProcessEnv = process.env,
): KernelProcessFlag {
  const raw = (env[KERNEL_PROCESS_FLAG] ?? "").trim().toLowerCase();
  const source: KernelProcessFlag["source"] = raw.length > 0 ? "explicit" : "default";

  if (DISABLED_VALUES.has(raw)) {
    return { enabled: false, reason: `${KERNEL_PROCESS_FLAG}=${raw}`, source };
  }
  if (raw.length > 0 && !ENABLED_VALUES.has(raw)) {
    return {
      enabled: false,
      reason: `${KERNEL_PROCESS_FLAG}=${raw} is not a recognized value (use 0/false/off to disable)`,
      source,
    };
  }
  if (process.platform === "win32") {
    return { enabled: false, reason: "xioflow kernel has no Windows process containment", source };
  }
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (major < MIN_KERNEL_NODE[0] || (major === MIN_KERNEL_NODE[0] && minor < MIN_KERNEL_NODE[1])) {
    return {
      enabled: false,
      reason: `node ${process.versions.node} is older than 22.5 (node:sqlite is required)`,
      source,
    };
  }
  return { enabled: true, reason: "kernel process path enabled", source };
}
