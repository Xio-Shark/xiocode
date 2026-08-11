import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBuiltinTools,
  resetSearchBackendCacheForTests,
  resolveGrepEngine,
  resolveRgBinary,
} from "./builtin.ts";
import { FileShiftRegistry, type FileShiftInfo } from "../file-shift.ts";
import { WorkspacePathPolicy } from "../workspace-path-policy.ts";

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

describe("builtin grep/glob search backends", () => {
  afterEach(() => {
    resetSearchBackendCacheForTests();
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

  it("uses Node fallback with explicit backend marker when forced unavailable", async () => {
    const root = await makeFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, searchEngine: "node" });
      const grep = await textOf(toolByName(tools, "grep"), { pattern: "needle" });
      expect(grep.isError).toBeFalsy();
      expect(grep.text.startsWith("backend=node (no ugrep/rg/grep)\n")).toBe(true);
      expect(grep.text).toContain("src/alpha.ts:1:");
      expect(grep.text).toContain("readme.md:1:");

      const glob = await textOf(toolByName(tools, "glob"), { pattern: "**/*.ts" });
      expect(glob.isError).toBeFalsy();
      expect(glob.text.startsWith("backend=node (no ugrep/rg/bfs/find)\n")).toBe(true);
      expect(glob.text).toContain("src/alpha.ts");
      expect(glob.text).toContain("src/beta.ts");
      expect(glob.text).not.toContain("readme.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("appends a structure outline on first hit and omits it on repeat (same session)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-builtin-outline-"));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(
        path.join(root, "src", "mod.ts"),
        "export function doThing() {\n  return 1;\n}\nexport class Widget {}\n",
        "utf8",
      );
      // Shared grep tool instance keeps the session seen-state across calls.
      const grep = toolByName(createBuiltinTools({ cwd: root, searchEngine: "node" }), "grep");
      const first = await textOf(grep, { pattern: "export" });
      expect(first.isError).toBeFalsy();
      expect(first.text).toContain("--- structure ---");
      expect(first.text).toContain("outline src/mod.ts (heuristic, not full AST):");
      expect(first.text).toContain("export class Widget {}");

      const second = await textOf(grep, { pattern: "export" });
      expect(second.text).toContain("outline src/mod.ts: omitted (already shown this session)");
      expect(second.text.length).toBeLessThan(first.text.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits the outline when grepOutline is disabled", async () => {
    const root = await makeFixture();
    try {
      const grep = toolByName(
        createBuiltinTools({ cwd: root, searchEngine: "node", grepOutline: false }),
        "grep",
      );
      const result = await textOf(grep, { pattern: "needle" });
      expect(result.text).not.toContain("--- structure ---");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to Node when the configured binary cannot be spawned", async () => {
    const root = await makeFixture();
    try {
      const tools = createBuiltinTools({
        cwd: root,
        searchEngine: path.join(root, "missing-rg-binary"),
      });
      const grep = await textOf(toolByName(tools, "grep"), { pattern: "needle", path: "src" });
      expect(grep.text.startsWith("backend=node (no ugrep/rg/grep)\n")).toBe(true);
      expect(grep.text).toContain("src/alpha.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats empty host search as successful empty grep/glob", async (ctx) => {
    const engine = await resolveGrepEngine("rg");
    if (engine.kind === "node") {
      ctx.skip();
    }
    const root = await makeFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, searchEngine: "rg" });
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

  it("uses forced rg backend for glob filter semantics", async (ctx) => {
    const rg = await resolveRgBinary();
    if (!rg) {
      ctx.skip();
    }
    const root = await makeFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, searchEngine: "rg" });
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

  it("prefers ugrep over rg when available and not overridden", async (ctx) => {
    resetSearchBackendCacheForTests();
    const engine = await resolveGrepEngine();
    if (engine.kind !== "ugrep") {
      ctx.skip();
    }
    const root = await makeFixture();
    try {
      const tools = createBuiltinTools({ cwd: root });
      const grep = await textOf(toolByName(tools, "grep"), {
        pattern: "needle",
        glob: "*.ts",
      });
      expect(grep.isError).toBeFalsy();
      expect(grep.text).toContain("src/alpha.ts:");
      expect(grep.text).not.toContain("readme.md");
      expect(grep.text).not.toContain("backend=node");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces host engine exit 2+ as a tool error with stderr snippet", async (ctx) => {
    const rg = await resolveRgBinary();
    if (!rg) {
      ctx.skip();
    }
    const root = await makeFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, searchEngine: "rg" });
      const grep = await textOf(toolByName(tools, "grep"), { pattern: "[" });
      expect(grep.isError).toBe(true);
      expect(grep.text.startsWith("rg failed (exit ")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caches engine resolution for the process", async () => {
    resetSearchBackendCacheForTests();
    const first = await resolveGrepEngine();
    const second = await resolveGrepEngine();
    expect(second).toEqual(first);
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

  async function readThen(
    tools: readonly ToolDefinition[],
    filePath: string,
  ): Promise<void> {
    const read = toolByName(tools, "read");
    const result = await textOf(read, { path: filePath });
    expect(result.isError).toBeFalsy();
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

      await readThen(tools, "exact.ts");
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

  it("rejects edit before read with Fix guidance", async () => {
    const root = await makeEditFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, workspaceRoot: root, writeBackVerify: false });
      const edit = toolByName(tools, "edit");
      const blocked = await textOf(edit, {
        path: "exact.ts",
        old_string: "const a = 1;",
        new_string: "const a = 10;",
      });
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain("not read");
      expect(blocked.text).toMatch(/Fix:/);
      expect(await readFile(path.join(root, "exact.ts"), "utf8")).toBe("const a = 1;\nconst b = 2;\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects overwrite write before read with Fix guidance", async () => {
    const root = await makeEditFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, workspaceRoot: root, writeBackVerify: false });
      const write = toolByName(tools, "write");
      const blocked = await textOf(write, {
        path: "exact.ts",
        content: "hijacked\n",
      });
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain("before overwrite");
      expect(blocked.text).toMatch(/Fix:/);
      expect(await readFile(path.join(root, "exact.ts"), "utf8")).toBe("const a = 1;\nconst b = 2;\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows create-write without prior read", async () => {
    const root = await makeEditFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, workspaceRoot: root, writeBackVerify: false });
      const write = toolByName(tools, "write");
      const created = await textOf(write, {
        path: "brand-new.ts",
        content: "ok\n",
      });
      expect(created.isError).toBeFalsy();
      expect(await readFile(path.join(root, "brand-new.ts"), "utf8")).toBe("ok\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous multi-match unless replace_all", async () => {
    const root = await makeEditFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, workspaceRoot: root, writeBackVerify: false });
      const edit = toolByName(tools, "edit");
      await readThen(tools, "multi.ts");
      const ambiguous = await textOf(edit, {
        path: "multi.ts",
        old_string: "foo",
        new_string: "baz",
      });
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.text).toContain("matched 2 times");
      expect(ambiguous.text).toContain("must be unique");
      expect(ambiguous.text).toMatch(/Fix:/);

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
      await readThen(tools, "crlf.ts");
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
      await readThen(tools, "exact.ts");

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

  it("serializes concurrent same-path write/edit without lost updates", async () => {
    const root = await makeEditFixture();
    try {
      const tools = createBuiltinTools({ cwd: root, workspaceRoot: root, writeBackVerify: false });
      await readThen(tools, "exact.ts");
      const edit = toolByName(tools, "edit");
      const write = toolByName(tools, "write");

      await Promise.all([
        textOf(edit, {
          path: "exact.ts",
          old_string: "const a = 1;",
          new_string: "const a = 2;",
        }),
        (async () => {
          await new Promise((r) => setTimeout(r, 5));
          return textOf(write, {
            path: "exact.ts",
            content: "final\n",
          });
        })(),
      ]);

      // Both completed through the queue; last scheduled write should be intact.
      expect(await readFile(path.join(root, "exact.ts"), "utf8")).toBe("final\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("builtin workspace path boundary", () => {
  it("denies direct outside reads and rejects final/ancestor symlinks without exposing canaries", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "xio-builtin-boundary-"));
    const root = path.join(base, "workspace");
    const outside = path.join(base, "outside");
    try {
      await mkdir(root);
      await mkdir(outside);
      const canary = path.join(outside, "canary.txt");
      await writeFile(canary, "UNREADABLE_CANARY\n", "utf8");
      await symlink(canary, path.join(root, "file-link.txt"));
      await symlink(outside, path.join(root, "dir-link"), "dir");
      const read = toolByName(createBuiltinTools({ cwd: root }), "read");

      for (const target of [canary, "../outside/canary.txt", "file-link.txt", "dir-link/canary.txt"]) {
        const result = await textOf(read, { path: target });
        expect(result.isError).toBe(true);
        expect(result.text).not.toContain("UNREADABLE_CANARY");
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("never follows a target or parent symlink during write/edit", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "xio-builtin-write-boundary-"));
    const root = path.join(base, "workspace");
    const outside = path.join(base, "outside");
    try {
      await mkdir(root);
      await mkdir(outside);
      const canary = path.join(outside, "canary.txt");
      await writeFile(canary, "outside\n", "utf8");
      await symlink(canary, path.join(root, "target.txt"));
      await symlink(outside, path.join(root, "linked-dir"), "dir");
      const tools = createBuiltinTools({
        cwd: root,
        workspaceRoot: root,
        requireReadBeforeEdit: false,
      });

      const write = toolByName(tools, "write");
      const edit = toolByName(tools, "edit");
      expect((await textOf(write, { path: "target.txt", content: "changed\n" })).isError).toBe(true);
      expect((await textOf(write, { path: "linked-dir/canary.txt", content: "changed\n" })).isError).toBe(true);
      expect((await textOf(edit, {
        path: "target.txt",
        old_string: "outside",
        new_string: "changed",
      })).isError).toBe(true);
      expect(await readFile(canary, "utf8")).toBe("outside\n");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("does not traverse workspace symlinks in Node grep/glob", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "xio-builtin-search-boundary-"));
    const root = path.join(base, "workspace");
    const outside = path.join(base, "outside");
    try {
      await mkdir(root);
      await mkdir(outside);
      await writeFile(path.join(root, "inside.txt"), "ordinary\n", "utf8");
      await writeFile(path.join(outside, "secret.txt"), "SEARCH_CANARY_39281\n", "utf8");
      await symlink(outside, path.join(root, "linked-dir"), "dir");
      const tools = createBuiltinTools({ cwd: root, searchEngine: "node" });
      const grep = await textOf(toolByName(tools, "grep"), { pattern: "SEARCH_CANARY_39281" });
      const glob = await textOf(toolByName(tools, "glob"), { pattern: "**/*" });
      expect(grep.text).not.toContain("SEARCH_CANARY_39281");
      expect(grep.text).not.toContain("secret.txt");
      expect(glob.text).not.toContain("linked-dir");
      expect(glob.text).not.toContain("secret.txt");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("consumes an exact pre-authorized outside read grant once", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "xio-builtin-grant-"));
    const root = path.join(base, "workspace");
    const outside = path.join(base, "outside.txt");
    try {
      await mkdir(root);
      await writeFile(outside, "granted\n", "utf8");
      const policy = await WorkspacePathPolicy.create({ workspaceRoot: root });
      const decision = await policy.inspect("read-file", outside);
      if (decision.decision !== "external") throw new Error("expected external request");
      policy.grantOnce("t1", decision.request);
      const read = toolByName(createBuiltinTools({ cwd: root, pathPolicy: policy }), "read");
      expect((await textOf(read, { path: outside })).text).toContain("granted");
      expect((await textOf(read, { path: outside })).isError).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("builtin cross-context file-shift notify", () => {
  it("fires once when a main write lands on a file an explore worker read, and dedupes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-file-shift-tool-"));
    try {
      await writeFile(path.join(root, "shared.ts"), "export const v = 1;\n", "utf8");
      const registry = new FileShiftRegistry();
      const shifts: FileShiftInfo[] = [];
      const onFileShift = (info: FileShiftInfo): void => {
        shifts.push(info);
      };

      // Explore worker (read-only context) reads the file.
      const explore = createBuiltinTools({ cwd: root, fileShift: registry, contextId: "explore-1" });
      const exploreRead = await textOf(toolByName(explore, "read"), { path: "shared.ts" });
      expect(exploreRead.isError).toBeFalsy();

      // Main agent reads (own context) then overwrites — a genuine cross-context shift.
      const main = createBuiltinTools({ cwd: root, fileShift: registry, contextId: "main", onFileShift });
      await textOf(toolByName(main, "read"), { path: "shared.ts" });
      const write = toolByName(main, "write");
      const first = await textOf(write, { path: "shared.ts", content: "export const v = 2;\n" });
      expect(first.isError).toBeFalsy();
      expect(shifts).toHaveLength(1);
      expect(shifts[0]).toMatchObject({ writer: "main", readers: ["explore-1"] });

      // Second write to the same path by the same writer must not re-notify.
      await textOf(write, { path: "shared.ts", content: "export const v = 3;\n" });
      expect(shifts).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not fire for a normal same-context read-then-write", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-file-shift-none-"));
    try {
      await writeFile(path.join(root, "solo.ts"), "export const s = 1;\n", "utf8");
      const registry = new FileShiftRegistry();
      const shifts: FileShiftInfo[] = [];
      const tools = createBuiltinTools({
        cwd: root,
        fileShift: registry,
        contextId: "main",
        onFileShift: (info) => shifts.push(info),
      });
      await textOf(toolByName(tools, "read"), { path: "solo.ts" });
      await textOf(toolByName(tools, "write"), { path: "solo.ts", content: "export const s = 2;\n" });
      expect(shifts).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
