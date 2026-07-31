import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  distributeTemplates,
  getSetupTemplate,
  isWorkspaceRoot,
  planTemplates,
  SETUP_TEMPLATES,
} from "../src/templates.ts";
import { runSetupCli } from "../src/setup-cli.ts";

describe("templates", () => {
  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  const makeWorkspace = async (options: { root?: boolean } = {}): Promise<string> => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "xio-setup-tpl-"));
    if (options.root !== false) {
      await mkdir(path.join(tmp, ".git"));
    }
    return tmp;
  };

  it("catalog paths all pass the norms allowlist", async () => {
    const ids = SETUP_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    const root = await makeWorkspace();
    const plan = await planTemplates(root, SETUP_TEMPLATES);
    expect(plan.rejected).toHaveLength(0);
    expect(plan.pending).toHaveLength(SETUP_TEMPLATES.length);
  });

  it("rejects non-allowlist paths and path escapes without writing", async () => {
    const root = await makeWorkspace();
    const evil = [
      { id: "escape", title: "escape", relativePath: "../outside.md", content: "x\n" },
      { id: "cursor", title: "cursor", relativePath: ".cursor/rules/x.mdc", content: "x\n" },
    ];
    const result = await distributeTemplates(root, evil);
    expect(result.written).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
    await expect(readFile(path.join(root, "..", "outside.md"), "utf8")).rejects.toThrow();
  });

  it("writes missing templates, then skips existing on re-run (never overwrites)", async () => {
    const root = await makeWorkspace();
    const first = await distributeTemplates(root, SETUP_TEMPLATES);
    expect([...first.written].sort()).toEqual(
      SETUP_TEMPLATES.map((template) => template.relativePath).sort(),
    );
    const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("# AGENTS.md");

    await writeFile(path.join(root, "AGENTS.md"), "user edited\n", "utf8");
    const second = await distributeTemplates(root, SETUP_TEMPLATES);
    expect(second.written).toHaveLength(0);
    expect(second.skippedExisting.length).toBe(SETUP_TEMPLATES.length);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("user edited\n");
  });

  it("CLI refuses outside a workspace root", async () => {
    const dir = await makeWorkspace({ root: false });
    expect(await isWorkspaceRoot(dir)).toBe(false);
    const out: string[] = [];
    const code = await runSetupCli(["templates", "add", "--yes"], {
      cwd: dir,
      write: (chunk) => out.push(chunk),
    });
    expect(code).toBe(1);
    expect(out.join("")).toContain("does not look like a workspace root");
  });

  it("CLI refuses to write without confirmation when non-interactive", async () => {
    const root = await makeWorkspace();
    const out: string[] = [];
    const code = await runSetupCli(["templates", "add"], {
      cwd: root,
      write: (chunk) => out.push(chunk),
      isTty: false,
    });
    expect(code).toBe(1);
    expect(out.join("")).toContain("refusing to write without confirmation");
    await expect(readFile(path.join(root, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  it("CLI declining the confirm prompt writes nothing", async () => {
    const root = await makeWorkspace();
    const out: string[] = [];
    const code = await runSetupCli(["templates", "add"], {
      cwd: root,
      write: (chunk) => out.push(chunk),
      ask: async () => "n",
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("aborted");
    await expect(readFile(path.join(root, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  it("CLI --yes writes a selected template and reports unknown ids", async () => {
    const root = await makeWorkspace();
    const out: string[] = [];
    const write = (chunk: string) => out.push(chunk);
    expect(getSetupTemplate("agents")).toBeDefined();
    expect(await runSetupCli(["templates", "add", "agents", "--yes"], { cwd: root, write })).toBe(0);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toContain("# AGENTS.md");
    await expect(
      readFile(path.join(root, ".trellis/spec/project.md"), "utf8"),
    ).rejects.toThrow();

    out.length = 0;
    expect(await runSetupCli(["templates", "add", "nope", "--yes"], { cwd: root, write })).toBe(1);
    expect(out.join("")).toContain("unknown template(s): nope");
  });

  it("CLI list shows status without writing", async () => {
    const root = await makeWorkspace();
    const out: string[] = [];
    expect(await runSetupCli(["templates"], { cwd: root, write: (c) => out.push(c) })).toBe(0);
    expect(out.join("")).toContain("project templates");
    await expect(readFile(path.join(root, "AGENTS.md"), "utf8")).rejects.toThrow();
  });
});
