/**
 * Which kernel platform driver supervises processes.
 *
 * `XIOCODE_KERNEL_DRIVER=auto` (default) uses the native reaper when the
 * kernel package ships its helper for this platform: it holds the whole
 * process tree, so `setsid` escapees are stopped instead of reported as
 * residuals. Otherwise the Node driver observes the tree through `ps(1)`.
 * The choice and its reason are reported (`/kernel`), never implied.
 *
 * Imports `@xioflow/kernel` (and so `node:sqlite`); load it dynamically.
 */

import { NodePlatformDriver, ReaperPlatformDriver, type PlatformDriver } from "@xioflow/kernel";

export type KernelDriverName = "reaper" | "node";

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
      throw new Error(`XIOCODE_KERNEL_DRIVER must be auto, node or reaper (got "${requested}")`);
  }
}
