#!/usr/bin/env node
/**
 * Runner wrapper for web visual baseline generation.
 * Can be run directly with `node scripts/web-visual-baseline.mjs`
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pyScript = path.join(__dirname, "web-visual-baseline.py");

const child = spawn("python3", [pyScript, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
