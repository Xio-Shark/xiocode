import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  atQuery,
  expandFileMentions,
  filterFiles,
  insertFileMention,
  listWorkspaceFiles,
} from "./file-mention.ts";
import { emptyComposer, setComposerText } from "./composer.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xio-mention-"));
  tempDirs.push(dir);
  return dir;
}

describe("atQuery", () => {
  it("returns the token after @ when the cursor is inside it", () => {
    expect(atQuery("look at @src/ap", 15)).toBe("src/ap");
    expect(atQuery("@", 1)).toBe("");
  });

  it("requires @ at start or after whitespace (emails do not trigger)", () => {
    expect(atQuery("mail me a@b.com", 15)).toBeUndefined();
  });

  it("is inactive when the cursor left the token or there is no @", () => {
    expect(atQuery("@src done", 9)).toBeUndefined();
    expect(atQuery("plain text", 10)).toBeUndefined();
  });
});

describe("filterFiles", () => {
  const files = ["src/tui/app.ts", "src/cli/entry.ts", "docs/app-notes.md", "README.md"];

  it("returns the head of the list for an empty query", () => {
    expect(filterFiles(files, "", 2)).toEqual(["src/tui/app.ts", "src/cli/entry.ts"]);
  });

  it("ranks basename prefix over directory substring over subsequence", () => {
    expect(filterFiles(files, "app")[0]).toBe("src/tui/app.ts");
    expect(filterFiles(files, "app")).toContain("docs/app-notes.md");
    expect(filterFiles(files, "sce")).toContain("src/cli/entry.ts");
  });

  it("drops non-matches entirely", () => {
    expect(filterFiles(files, "zzz")).toEqual([]);
  });
});

describe("insertFileMention", () => {
  it("replaces the active token and moves the cursor past the inserted space", () => {
    const state = setComposerText(emptyComposer(), "check @ap please");
    const inserted = insertFileMention({ ...state, cursor: 9 }, "src/tui/app.ts");
    expect(inserted.text).toBe("check @src/tui/app.ts  please");
    expect(inserted.cursor).toBe("check @src/tui/app.ts ".length);
  });

  it("is a no-op without an active token", () => {
    const state = setComposerText(emptyComposer(), "no token");
    expect(insertFileMention(state, "x.ts")).toBe(state);
  });
});

describe("listWorkspaceFiles", () => {
  it("respects .gitignore inside a git repo", async () => {
    const dir = await makeTempDir();
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    await writeFile(path.join(dir, ".gitignore"), "secret.txt\n");
    await writeFile(path.join(dir, "kept.ts"), "export {};\n");
    await writeFile(path.join(dir, "secret.txt"), "nope\n");
    const files = await listWorkspaceFiles(dir);
    expect(files).toContain("kept.ts");
    expect(files).not.toContain("secret.txt");
  });

  it("falls back to a bounded walk outside git, skipping build dirs", async () => {
    const dir = await makeTempDir();
    await mkdir(path.join(dir, "node_modules/pkg"), { recursive: true });
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "node_modules/pkg/index.js"), "x");
    await writeFile(path.join(dir, "src/a.ts"), "x");
    const files = await listWorkspaceFiles(dir);
    expect(files).toContain("src/a.ts");
    expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
  });
});

describe("expandFileMentions", () => {
  it("appends bounded file blocks for resolvable mentions only", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "hello.ts"), "export const hi = 1;\n");
    const out = await expandFileMentions("read @hello.ts and ping @nobody", dir);
    expect(out).toContain("read @hello.ts and ping @nobody");
    expect(out).toContain('<file path="hello.ts">');
    expect(out).toContain("export const hi = 1;");
    expect(out).not.toContain('path="nobody"');
  });

  it("returns input unchanged when nothing resolves", async () => {
    const dir = await makeTempDir();
    const text = "no mentions here, just a@b email";
    expect(await expandFileMentions(text, dir)).toBe(text);
  });

  it("truncates oversized files and never escapes the root", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "big.txt"), "x".repeat(20_000));
    const out = await expandFileMentions("see @big.txt and @../../etc/passwd", dir);
    expect(out).toContain("truncated=");
    expect(out).not.toContain('path="../../etc/passwd"');
    expect(out.length).toBeLessThan(20_000 + 500);
  });
});
