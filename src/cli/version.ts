import { createRequire } from "node:module";

/** Package version only — keep this module free of launch/session/tui imports. */
export function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const XIO_VERSION = readPackageVersion();
