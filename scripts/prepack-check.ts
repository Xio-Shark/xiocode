#!/usr/bin/env node
/**
 * Fail pack/publish when installable entrypoints are missing.
 * Published payload is AOT-only: bin/ + dist/ (no src/ or extensions/).
 */
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "bin/xio",
  "bin/xio-setup",
  "dist/xio.js",
  "dist/xio-setup.js",
  "dist/web/index.html",
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

// A `file:` dependency (e.g. a vendored kernel tarball used while the kernel
// release is pending) cannot be resolved by anyone installing from npm.
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const localDeps = Object.entries(manifest.dependencies ?? {})
  .filter(([, spec]) => spec.startsWith("file:") || spec.startsWith("link:"));
if (localDeps.length > 0) {
  console.error(
    `prepack-check failed; local dependency specs cannot be published: ${
      localDeps.map(([name, spec]) => `${name}@${spec}`).join(", ")
    }`,
  );
  process.exit(1);
}
console.log("prepack-check ok");
