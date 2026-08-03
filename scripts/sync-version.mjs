#!/usr/bin/env node
/**
 * Keep version pins in README docs in sync with package.json during
 * `npm version` (the `version` lifecycle hook runs it before the commit).
 * Covers the static version badge and the pinned-install example.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`unexpected package version: ${String(version)}`);
}

for (const file of ["README.md", "README.zh-CN.md"]) {
  const target = path.join(root, file);
  let text = readFileSync(target, "utf8");
  const before = text;
  text = text.replace(/version-\d+\.\d+\.\d+/, `version-${version}`);
  text = text.replace(/XIO_INSTALL_VERSION=\d+\.\d+\.\d+/, `XIO_INSTALL_VERSION=${version}`);
  if (text !== before) {
    writeFileSync(target, text);
    console.log(`synced ${file} → ${version}`);
  }
}
