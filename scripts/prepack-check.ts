#!/usr/bin/env node
/**
 * Fail pack/publish when installable entrypoints are missing.
 * Runtime ships TypeScript sources executed via Node --experimental-strip-types.
 */
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "bin/xio",
  "bin/xio-improve",
  "src/cli/index.ts",
  "src/cli/improve-entry.ts",
  "package.json",
  "LICENSE",
];

const missing: string[] = [];
for (const rel of required) {
  try {
    await access(path.join(root, rel));
  } catch {
    missing.push(rel);
  }
}
if (missing.length > 0) {
  console.error(`prepack-check failed; missing: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("prepack-check ok");
