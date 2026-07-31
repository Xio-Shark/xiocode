import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyParallelSection,
  buildParallelBlock,
  hasParallelSection,
  planTrellisUpdate,
} from "../src/trellis-setup.ts";
import { runSetupCli } from "../src/setup-cli.ts";

const BASE_CONFIG = `# Trellis Configuration
session_commit_message: "chore: record journal"
max_journal_lines: 2000

# parallel:
#   auto_confirm: false
`;

describe("trellis dag", () => {
  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  const makeWorkspace = async (config: string | null = BASE_CONFIG): Promise<string> => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "xio-setup-trellis-"));
    await mkdir(path.join(tmp, ".trellis"), { recursive: true });
    if (config !== null) {
      await writeFile(path.join(tmp, ".trellis/config.yaml"), config, "utf8");
    }
    return tmp;
  };

  it("hasParallelSection: real table counts, commented example does not", () => {
    expect(hasParallelSection(BASE_CONFIG)).toBe(false);
    expect(hasParallelSection(`${BASE_CONFIG}\nparallel:\n  worker: xio\n`)).toBe(true);
  });

  it("applyParallelSection appends once, idempotently, and parses back", () => {
    const next = applyParallelSection(BASE_CONFIG, { maxConcurrency: 4, worker: "channel" });
    expect(hasParallelSection(next)).toBe(true);
    expect(next).toContain("max_concurrency: 4");
    expect(next).toContain("worker: channel");
    expect(next).toContain("auto_confirm: false");
    expect(applyParallelSection(next)).toBe(next);
  });

  it("buildParallelBlock defaults keep the human-confirm dry-run behavior", () => {
    const block = buildParallelBlock();
    expect(block).toContain("auto_confirm: false");
    expect(block).toContain("max_concurrency: 8");
    expect(block).toContain("worker: xio");
  });

  it("CLI dag with flags writes the section non-interactively", async () => {
    const root = await makeWorkspace();
    const out: string[] = [];
    const code = await runSetupCli(
      ["trellis", "dag", "--auto-confirm", "--max-concurrency", "2", "--worker", "channel"],
      { cwd: root, write: (chunk) => out.push(chunk), isTty: false },
    );
    expect(code).toBe(0);
    const config = await readFile(path.join(root, ".trellis/config.yaml"), "utf8");
    expect(config).toContain("auto_confirm: true");
    expect(config).toContain("max_concurrency: 2");
    expect(config).toContain("worker: channel");
    // original content preserved
    expect(config).toContain("session_commit_message");
  });

  it("CLI dag is a no-op when parallel: already present", async () => {
    const root = await makeWorkspace(`${BASE_CONFIG}\nparallel:\n  worker: xio\n`);
    const out: string[] = [];
    const before = await readFile(path.join(root, ".trellis/config.yaml"), "utf8");
    const code = await runSetupCli(["trellis", "dag"], {
      cwd: root,
      write: (chunk) => out.push(chunk),
      isTty: false,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("already present");
    expect(await readFile(path.join(root, ".trellis/config.yaml"), "utf8")).toBe(before);
  });

  it("CLI dag rejects invalid flags without writing", async () => {
    const root = await makeWorkspace();
    const out: string[] = [];
    expect(
      await runSetupCli(["trellis", "dag", "--max-concurrency", "0"], {
        cwd: root,
        write: (chunk) => out.push(chunk),
        isTty: false,
      }),
    ).toBe(1);
    expect(
      await runSetupCli(["trellis", "dag", "--worker", "nope"], {
        cwd: root,
        write: (chunk) => out.push(chunk),
        isTty: false,
      }),
    ).toBe(1);
    const config = await readFile(path.join(root, ".trellis/config.yaml"), "utf8");
    expect(hasParallelSection(config)).toBe(false);
  });

  it("CLI dag interactive prompts drive the written values", async () => {
    const root = await makeWorkspace();
    const answers = ["y", "3", "xio"];
    const code = await runSetupCli(["trellis", "dag"], {
      cwd: root,
      write: () => {},
      ask: async () => answers.shift() ?? "",
    });
    expect(code).toBe(0);
    const config = await readFile(path.join(root, ".trellis/config.yaml"), "utf8");
    expect(config).toContain("auto_confirm: true");
    expect(config).toContain("max_concurrency: 3");
  });

  it("CLI dag fails cleanly without a config.yaml", async () => {
    const root = await makeWorkspace(null);
    const out: string[] = [];
    const code = await runSetupCli(["trellis", "dag"], {
      cwd: root,
      write: (chunk) => out.push(chunk),
      isTty: false,
    });
    expect(code).toBe(1);
    expect(out.join("")).toContain("not found");
  });
});

describe("trellis update", () => {
  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  /** Workspace with .trellis plus a local template dir acting as --source. */
  const makeFixture = async (): Promise<{ root: string; source: string }> => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "xio-setup-trup-"));
    const root = path.join(tmp, "ws");
    const source = path.join(tmp, "tpl");
    await mkdir(path.join(root, ".trellis/scripts/common"), { recursive: true });
    await mkdir(path.join(source, "scripts/common"), { recursive: true });
    await mkdir(path.join(source, "agents"), { recursive: true });
    await writeFile(path.join(source, "workflow.md"), "workflow v2\n", "utf8");
    await writeFile(path.join(source, "scripts/task.py"), "task v2\n", "utf8");
    await writeFile(path.join(source, "scripts/common/task_deps.py"), "deps v1\n", "utf8");
    await writeFile(path.join(source, "agents/implement.md"), "agent v1\n", "utf8");
    // local state: workflow outdated, task.py current, deps + agent missing
    await writeFile(path.join(root, ".trellis/workflow.md"), "workflow v1\n", "utf8");
    await writeFile(path.join(root, ".trellis/scripts/task.py"), "task v2\n", "utf8");
    await writeFile(path.join(root, ".trellis/config.yaml"), "user: config\n", "utf8");
    return { root, source };
  };

  it("plan classifies add / update / skip and never plans deletions", async () => {
    const { root, source } = await makeFixture();
    const plan = await planTrellisUpdate(source, path.join(root, ".trellis"));
    const byPath = Object.fromEntries(plan.entries.map((e) => [e.relativePath, e.action]));
    expect(byPath["workflow.md"]).toBe("update");
    expect(byPath[path.join("scripts", "task.py")]).toBe("skip");
    expect(byPath[path.join("scripts", "common", "task_deps.py")]).toBe("add");
    expect(byPath[path.join("agents", "implement.md")]).toBe("add");
    expect(plan.pending).toHaveLength(3);
  });

  it("CLI update --source --yes writes pending files, leaves user data alone", async () => {
    const { root, source } = await makeFixture();
    const out: string[] = [];
    const code = await runSetupCli(["trellis", "update", "--source", source, "--yes"], {
      cwd: root,
      write: (chunk) => out.push(chunk),
      isTty: false,
    });
    expect(code).toBe(0);
    expect(await readFile(path.join(root, ".trellis/workflow.md"), "utf8")).toBe("workflow v2\n");
    expect(
      await readFile(path.join(root, ".trellis/scripts/common/task_deps.py"), "utf8"),
    ).toBe("deps v1\n");
    expect(await readFile(path.join(root, ".trellis/config.yaml"), "utf8")).toBe("user: config\n");

    // re-run: everything up to date
    out.length = 0;
    const again = await runSetupCli(["trellis", "update", "--source", source, "--yes"], {
      cwd: root,
      write: (chunk) => out.push(chunk),
      isTty: false,
    });
    expect(again).toBe(0);
    expect(out.join("")).toContain("already up to date");
  });

  it("CLI update refuses without confirmation when non-interactive", async () => {
    const { root, source } = await makeFixture();
    const out: string[] = [];
    const code = await runSetupCli(["trellis", "update", "--source", source], {
      cwd: root,
      write: (chunk) => out.push(chunk),
      isTty: false,
    });
    expect(code).toBe(1);
    expect(out.join("")).toContain("refusing to write without confirmation");
    expect(await readFile(path.join(root, ".trellis/workflow.md"), "utf8")).toBe("workflow v1\n");
  });

  it("CLI update declining the prompt writes nothing", async () => {
    const { root, source } = await makeFixture();
    const code = await runSetupCli(["trellis", "update", "--source", source], {
      cwd: root,
      write: () => {},
      ask: async () => "n",
    });
    expect(code).toBe(0);
    expect(await readFile(path.join(root, ".trellis/workflow.md"), "utf8")).toBe("workflow v1\n");
  });

  it("CLI update rejects a bogus --source and a missing .trellis", async () => {
    const { root } = await makeFixture();
    const out: string[] = [];
    expect(
      await runSetupCli(["trellis", "update", "--source", path.join(root, "nope"), "--yes"], {
        cwd: root,
        write: (chunk) => out.push(chunk),
        isTty: false,
      }),
    ).toBe(1);
    expect(out.join("")).toContain("neither a Trellis repo root nor a template dir");

    out.length = 0;
    const bare = await mkdtemp(path.join(os.tmpdir(), "xio-setup-bare-"));
    try {
      expect(
        await runSetupCli(["trellis", "update", "--yes"], {
          cwd: bare,
          write: (chunk) => out.push(chunk),
          isTty: false,
        }),
      ).toBe(1);
      expect(out.join("")).toContain(".trellis");
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("trellis status", () => {
  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("reports missing .trellis, then DAG/config state", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "xio-setup-trst-"));
    const out: string[] = [];
    const write = (chunk: string) => out.push(chunk);
    expect(await runSetupCli(["trellis"], { cwd: tmp, write, isTty: false })).toBe(1);
    expect(out.join("")).toContain(".trellis: missing");

    await mkdir(path.join(tmp, ".trellis/scripts/common"), { recursive: true });
    await writeFile(path.join(tmp, ".trellis/scripts/common/task_deps.py"), "x\n", "utf8");
    await writeFile(path.join(tmp, ".trellis/config.yaml"), "parallel:\n  worker: xio\n", "utf8");
    out.length = 0;
    expect(await runSetupCli(["trellis"], { cwd: tmp, write, isTty: false })).toBe(0);
    const text = out.join("");
    expect(text).toContain("✓ DAG scripts");
    expect(text).toContain("✓ parallel: config");
  });
});
