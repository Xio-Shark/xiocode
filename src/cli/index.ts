#!/usr/bin/env node

/**
 * Library / test facade. Production binary uses `entry.ts` (or dist/xio.mjs) so
 * re-exports of launch/session never load on `xio --version`.
 */

export { parseXioArgs, shouldUseInk } from "./cli-args.ts";
export { prepareLaunch } from "./launch.ts";
export type { XioArgs } from "./cli-args.ts";
export type { LaunchPlan } from "./launch.ts";
export { XIO_VERSION } from "./version.ts";
export { handleXioFlag, xioHelp } from "./router-help.ts";
export { isDirectRunEntry } from "./entry.ts";

// When this module is executed as a script (legacy path), delegate to the thin entry.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (isThisModuleDirectRun()) {
  await import("./entry.ts");
}

function isThisModuleDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
