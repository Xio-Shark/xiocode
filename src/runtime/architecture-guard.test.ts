/**
 * Mechanical architecture / shipping guards (harness-style).
 * Documented layers must not silently invert; unshipped optimizers must not appear on the default path.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Symbols that STATUS marks not-on-default-path — must not be imported by default assembly. */
const UNSHIPPED_DEFAULT_SYMBOLS = [
  "StrategyLearner",
  "PromptEvolver",
  "SpeculativeExecutor",
] as const;

async function listTsFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    if (match[1]) {
      specs.push(match[1]);
    }
  }
  // also side-effect imports
  const re2 = /import\s+["']([^"']+)["']/g;
  while ((match = re2.exec(source)) !== null) {
    if (match[1]) {
      specs.push(match[1]);
    }
  }
  return specs;
}

describe("architecture import boundaries", () => {
  it("extensions must not import src/tui", async () => {
    const files = await listTsFiles(path.join(REPO_ROOT, "extensions"));
    const violations: string[] = [];
    for (const file of files) {
      if (file.includes(`${path.sep}test${path.sep}`)) {
        continue;
      }
      const source = await readFile(file, "utf8");
      for (const spec of importSpecifiers(source)) {
        if (
          spec.includes("/tui/")
          || spec.includes("/src/tui")
          || /(^|\/)tui\//.test(spec)
          || spec.endsWith("/tui")
        ) {
          violations.push(`${path.relative(REPO_ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("src/runtime must not import src/tui", async () => {
    const files = await listTsFiles(path.join(REPO_ROOT, "src/runtime"));
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const spec of importSpecifiers(source)) {
        if (spec.includes("../tui/") || spec.includes("/tui/") || spec.includes("src/tui")) {
          violations.push(`${path.relative(REPO_ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("default path does not register unshipped optimizers", () => {
  it("evolve index and xio-extension omit StrategyLearner / PromptEvolver / SpeculativeExecutor", async () => {
    const targets = [
      path.join(REPO_ROOT, "extensions/xio-evolve/src/index.ts"),
      path.join(REPO_ROOT, "src/cli/xio-extension.ts"),
    ];
    for (const file of targets) {
      const code = stripTsComments(await readFile(file, "utf8"));
      for (const symbol of UNSHIPPED_DEFAULT_SYMBOLS) {
        expect(
          new RegExp(String.raw`\b${symbol}\b`).test(code),
          `${path.relative(REPO_ROOT, file)} must not wire ${symbol} outside comments`,
        ).toBe(false);
      }
    }
  });

  it("default evolve registration comment documents intentional omission", async () => {
    const source = await readFile(
      path.join(REPO_ROOT, "extensions/xio-evolve/src/index.ts"),
      "utf8",
    );
    expect(source).toMatch(/StrategyLearner/);
    expect(source).toMatch(/intentionally not registered/i);
  });
});
