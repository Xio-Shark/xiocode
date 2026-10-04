/**
 * Which kernel platform driver supervises processes.
 *
 * `XIOCODE_KERNEL_DRIVER=auto` (default) uses the native reaper when the
 * kernel package ships its helper for this platform: it holds the whole
 * process tree, so `setsid` escapees are stopped instead of reported as
 * residuals. Otherwise the Node driver observes the tree through `ps(1)`.
 * `XIOCODE_KERNEL_DRIVER=cgroup` (Linux) puts every command in its own cgroup v2:
 * nothing it forks can escape, and crash recovery reaps what is left. It needs a
 * cgroup delegated to xiocode (`systemd-run --user --scope -p Delegate=yes xio`)
 * and moves the processes of that cgroup into a leaf, so `auto` never picks it.
 * The choice and its reason are reported (`/kernel`), never implied.
 *
 * Imports `@xioflow/kernel` (and so `node:sqlite`); load it dynamically.
 */

import { CgroupPlatformDriver, NodePlatformDriver, ReaperPlatformDriver, type PlatformDriver } from "@xioflow/kernel";

export type KernelDriverName = "reaper" | "node" | "cgroup";

export type KernelDriverChoice = Readonly<{
  name: KernelDriverName;
  reason: string;
  create: () => PlatformDriver;
}>;

export function resolveKernelDriver(env: NodeJS.ProcessEnv = process.env): KernelDriverChoice {
  const requested = env.XIOCODE_KERNEL_DRIVER?.trim().toLowerCase() || "auto";
  switch (requested) {
    case "node":
      return { name: "node", reason: "XIOCODE_KERNEL_DRIVER=node", create: () => new NodePlatformDriver() };
    case "cgroup":
      // The constructor throws CgroupUnavailableError with the reason; that error reaches the user.
      return { name: "cgroup", reason: "XIOCODE_KERNEL_DRIVER=cgroup", create: () => new CgroupPlatformDriver() };
    case "reaper":
      // The constructor throws when the helper is missing; that error reaches the user.
      return { name: "reaper", reason: "XIOCODE_KERNEL_DRIVER=reaper", create: () => new ReaperPlatformDriver() };
    case "auto":
      return ReaperPlatformDriver.isAvailable()
        ? { name: "reaper", reason: "native helper available", create: () => new ReaperPlatformDriver() }
        : {
          name: "node",
          reason: `no native reaper helper for ${process.platform}-${process.arch}`,
          create: () => new NodePlatformDriver(),
        };
    default:
      throw new Error(`XIOCODE_KERNEL_DRIVER must be auto, node, reaper or cgroup (got "${requested}")`);
  }
}
