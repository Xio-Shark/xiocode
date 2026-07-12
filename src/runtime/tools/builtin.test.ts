import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBuiltinTools,
  resetRgBinaryCacheForTests,
  resolveRgBinary,
} from "./builtin.ts";

import type { ToolDefinition } from "../types.ts";

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-builtin-rg-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "alpha.ts"), " const needle = 1;\nexport const alpha = needle;\n", "utf8");
  await writeFile(path.join(root, "src", "beta.ts"), "export const beta = 2;\n", "utf8");
  await writeFile(path.join(root, "readme.md"), "# hello needle\n", "utf8");
  return root;
}

function toolByName(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`missing tool ${name}`);
  }
  return tool;
}

async function textOf(
  tool: ToolDefinition,
  params: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  const result = await tool.execute("t1", params);
  const text = result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
  return { text, isError: result.isError };
}

describe("builtin grep/glob ripgrep backends", () => {
  afterEach(() => {
    resetRgBinaryCacheForTests();
  });

  it("keeps grep and glob parameter schemas unchanged", () => {
    const tools = createBuiltinTools();
    const grep = toolByName(tools, "grep");
    const glob = toolByName(tools, "glob");
    expect(Object.keys(grep.parameters.properties ?? {}).sort()).toEqual(["glob", "path", "pattern"]);
    expect(grep.parameters.required).toEqual(["pattern"]);
    expect(Object.keys(glob.parameters.properties ?? {}).sort()).toEqual(["path", "pattern"]);
    expect(glob.parameters.required).toEqual(["pattern"]);
  });

  it("uses Node fallback with explicit backend marker when rg is forced unavailable", async () => {
    const root = await makeFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, rgBinary: null });
      const grep = await textOf(toolByName(tools, "grep"), { pattern: "needle" });
      expect(grep.isError).toBeFalsy();
      expect(grep.text.startsWith("backend=node (rg unavailable)\n")).toBe(true);
      expect(grep.text).toContain("src/alpha.ts:1:");
      expect(grep.text).toContain("readme.md:1:");

      const glob = await textOf(toolByName(tools, "glob"), { pattern: "**/*.ts" });
      expect(glob.isError).toBeFalsy();
      expect(glob.text.startsWith("backend=node (rg unavailable)\n")).toBe(true);
      expect(glob.text).toContain("src/alpha.ts");
      expect(glob.text).toContain("src/beta.ts");
      expect(glob.text).not.toContain("readme.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to Node when the configured rg binary cannot be spawned", async () => {
    const root = await makeFixture();
    try {
      const tools = createBuiltinTools({
        cwd: root,
        rgBinary: path.join(root, "missing-rg-binary"),
      });
      const grep = await textOf(toolByName(tools, "grep"), { pattern: "needle", path: "src" });
      expect(grep.text.startsWith("backend=node (rg unavailable)\n")).toBe(true);
      expect(grep.text).toContain("src/alpha.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats rg exit 1 as successful empty grep/glob", async (ctx) => {
    const rg = await resolveRgBinary();
    if (!rg) {
      ctx.skip();
    }
    const root = await makeFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, rgBinary: rg });
      const grep = await textOf(toolByName(tools, "grep"), { pattern: "zzz_no_such_token_zzz" });
      expect(grep.isError).toBeFalsy();
      expect(grep.text).toBe("no matches");
      expect(grep.text).not.toContain("backend=node");

      const glob = await textOf(toolByName(tools, "glob"), { pattern: "**/*.missing" });
      expect(glob.isError).toBeFalsy();
      expect(glob.text).toBe("no files");
      expect(glob.text).not.toContain("backend=node");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses ripgrep backend when rg is available", async (ctx) => {
    const rg = await resolveRgBinary();
    if (!rg) {
      ctx.skip();
    }
    const root = await makeFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, rgBinary: rg });
      const grep = await textOf(toolByName(tools, "grep"), {
        pattern: "needle",
        glob: "*.ts",
      });
      expect(grep.isError).toBeFalsy();
      expect(grep.text).not.toContain("backend=node");
      expect(grep.text).toContain("src/alpha.ts:");
      expect(grep.text).not.toContain("readme.md");

      const glob = await textOf(toolByName(tools, "glob"), { pattern: "**/*.ts" });
      expect(glob.isError).toBeFalsy();
      expect(glob.text).not.toContain("backend=node");
      expect(glob.text.split("\n").sort()).toEqual(["src/alpha.ts", "src/beta.ts"].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces rg exit 2+ as a tool error with stderr snippet", async (ctx) => {
    const rg = await resolveRgBinary();
    if (!rg) {
      ctx.skip();
    }
    const root = await makeFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, rgBinary: rg });
      const grep = await textOf(toolByName(tools, "grep"), { pattern: "[" });
      expect(grep.isError).toBe(true);
      expect(grep.text.startsWith("rg failed (exit ")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caches rg resolution for the process", async () => {
    resetRgBinaryCacheForTests();
    const first = await resolveRgBinary();
    const second = await resolveRgBinary();
    expect(second).toBe(first);
  });
});

describe("builtin edit robustness", () => {
  async function makeEditFixture(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-builtin-edit-"));
    await writeFile(path.join(root, "exact.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    await writeFile(path.join(root, "multi.ts"), "foo\nbar\nfoo\n", "utf8");
    await writeFile(path.join(root, "crlf.ts"), "const a = 1;  \r\nconst b = 2;\r\n", "utf8");
    return root;
  }

  it("keeps exact unique replace as the default", async () => {
    const root = await makeEditFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, workspaceRoot: root, writeBackVerify: false });
      const edit = toolByName(tools, "edit");
      expect(Object.keys(edit.parameters.properties ?? {}).sort()).toEqual([
        "new_string",
        "old_string",
        "patch",
        "path",
        "replace_all",
      ]);
      expect(edit.parameters.required).toEqual(["path"]);

      const result = await textOf(edit, {
        path: "exact.ts",
        old_string: "const a = 1;",
        new_string: "const a = 10;",
      });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("edited");
      expect(result.text).not.toContain("fuzzy:");
      expect(await readFile(path.join(root, "exact.ts"), "utf8")).toBe("const a = 10;\nconst b = 2;\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous multi-match unless replace_all", async () => {
    const root = await makeEditFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, workspaceRoot: root, writeBackVerify: false });
      const edit = toolByName(tools, "edit");
      const ambiguous = await textOf(edit, {
        path: "multi.ts",
        old_string: "foo",
        new_string: "baz",
      });
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.text).toContain("matched 2 times");
      expect(ambiguous.text).toContain("must be unique");

      const replaced = await textOf(edit, {
        path: "multi.ts",
        old_string: "foo",
        new_string: "baz",
        replace_all: true,
      });
      expect(replaced.isError).toBeFalsy();
      expect(await readFile(path.join(root, "multi.ts"), "utf8")).toBe("baz\nbar\nbaz\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fuzzy-retries CRLF and trailing-space drift with annotation", async () => {
    const root = await makeEditFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, workspaceRoot: root, writeBackVerify: false });
      const edit = toolByName(tools, "edit");
      const result = await textOf(edit, {
        path: "crlf.ts",
        old_string: "const a = 1;\nconst b = 2;\n",
        new_string: "const a = 1;\nconst b = 20;\n",
      });
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain("fuzzy: whitespace normalized");
      expect(await readFile(path.join(root, "crlf.ts"), "utf8")).toBe("const a = 1;\nconst b = 20;\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies a unified patch and reports parse/apply failures", async () => {
    const root = await makeEditFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, workspaceRoot: root, writeBackVerify: false });
      const edit = toolByName(tools, "edit");

      const ok = await textOf(edit, {
        path: "exact.ts",
        patch: [
          "--- exact.ts",
          "+++ exact.ts",
          "@@ -1,2 +1,2 @@",
          " const a = 1;",
          "-const b = 2;",
          "+const b = 3;",
          "",
        ].join("\n"),
      });
      expect(ok.isError).toBeFalsy();
      expect(ok.text).toContain("edited");
      expect(await readFile(path.join(root, "exact.ts"), "utf8")).toBe("const a = 1;\nconst b = 3;\n");

      const parseFail = await textOf(edit, {
        path: "exact.ts",
        patch: "not a real patch",
      });
      expect(parseFail.isError).toBe(true);
      expect(parseFail.text).toContain("patch parse error");

      const applyFail = await textOf(edit, {
        path: "exact.ts",
        patch: [
          "--- exact.ts",
          "+++ exact.ts",
          "@@ -1,2 +1,2 @@",
          " const a = 1;",
          "-const b = 999;",
          "+const b = 4;",
          "",
        ].join("\n"),
      });
      expect(applyFail.isError).toBe(true);
      expect(applyFail.text).toContain("patch apply error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still enforces workspace containment for edit", async () => {
    const root = await makeEditFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, workspaceRoot: root, writeBackVerify: false });
      const edit = toolByName(tools, "edit");
      const escaped = await textOf(edit, {
        path: "../outside.ts",
        old_string: "a",
        new_string: "b",
      });
      expect(escaped.isError).toBe(true);
      expect(escaped.text).toContain("path escapes workspace root");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
