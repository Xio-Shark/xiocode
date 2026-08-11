import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GrepSeenState,
  annotateGrepOutput,
  extractOutline,
  hitFilesFromGrep,
} from "./grep-outline.ts";

describe("extractOutline (heuristic symbols)", () => {
  it("extracts exported TS declarations and arrow assignments", () => {
    const content = [
      "import x from 'y';",
      "export function doThing() {",
      "  return 1;",
      "}",
      "export class Widget {}",
      "const helper = () => 42;",
      "const plain = 7;",
    ].join("\n");
    const symbols = extractOutline("src/mod.ts", content);
    const texts = symbols.map((s) => s.text);
    expect(texts).toContain("export function doThing() {");
    expect(texts).toContain("export class Widget {}");
    expect(texts).toContain("const helper = () => 42;");
    // Plain non-function const is not a symbol line.
    expect(texts).not.toContain("const plain = 7;");
  });

  it("uses python def/class rules by extension", () => {
    const content = ["import os", "def run():", "    pass", "class Thing:", "    pass"].join("\n");
    const texts = extractOutline("app/main.py", content).map((s) => s.text);
    expect(texts).toContain("def run():");
    expect(texts).toContain("class Thing:");
    expect(texts).not.toContain("import os");
  });

  it("caps the number of returned symbols", () => {
    const content = Array.from({ length: 50 }, (_, i) => `export function fn${i}() {}`).join("\n");
    expect(extractOutline("src/many.ts", content, 5)).toHaveLength(5);
  });
});

describe("hitFilesFromGrep", () => {
  it("parses de-duplicated relpaths from grep hit lines", () => {
    const text = [
      "src/a.ts:10:const foo = 1;",
      "src/a.ts:20:const bar = 2;",
      "src/b.ts:3:export function baz() {}",
      "no matches",
    ].join("\n");
    expect(hitFilesFromGrep(text)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("annotateGrepOutput adaptive truncation", () => {
  it("appends a full outline for a new file and omits it on repeat", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-grep-outline-"));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(
        path.join(root, "src", "mod.ts"),
        [
          "export function doThing() {",
          "  return 1;",
          "}",
          "export class Widget {}",
        ].join("\n"),
        "utf8",
      );
      const matchText = "src/mod.ts:1:export function doThing() {";
      const seen = new GrepSeenState();
      const readText = (filePath: string) => readFile(filePath, "utf8");

      const first = await annotateGrepOutput(matchText, { cwd: root, seen, readText });
      expect(first).toContain("--- structure ---");
      expect(first).toContain("outline src/mod.ts (heuristic, not full AST):");
      expect(first).toContain("export class Widget {}");

      const second = await annotateGrepOutput(matchText, { cwd: root, seen, readText });
      expect(second).toContain("outline src/mod.ts: omitted (already shown this session)");
      expect(second).not.toContain("export class Widget {}");
      // Adaptive truncation: repeat output is strictly shorter than the first.
      expect(second.length).toBeLessThan(first.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves 'no matches' untouched", async () => {
    const seen = new GrepSeenState();
    expect(await annotateGrepOutput("no matches", {
      cwd: process.cwd(),
      seen,
      readText: (filePath) => readFile(filePath, "utf8"),
    })).toBe("no matches");
  });

  it("uses the injected checked reader for every secondary outline read", async () => {
    const requested: string[] = [];
    const result = await annotateGrepOutput("../outside.ts:1:export const secret = 1;", {
      cwd: "/workspace",
      seen: new GrepSeenState(),
      readText: async (filePath) => {
        requested.push(filePath);
        throw new Error("blocked by policy");
      },
    });
    expect(requested).toEqual([path.resolve("/workspace", "../outside.ts")]);
    expect(result).not.toContain("--- structure ---");
  });
});
