import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ExtensionHost } from "../extension-host.ts";
import { formatPlanAck, formatPlanListCompact, formatTasklistWidget } from "./format.ts";
import { createPlanTool } from "./plan-tool.ts";
import { registerPlanCapability } from "./register.ts";
import {
  createEmptyBoard,
  exportTasksCsv,
  loadPlanBoard,
  parsePlanBoard,
  savePlanBoard,
} from "./store.ts";
import { LEGACY_PLAN_DIR, PLAN_DIR } from "./types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("plan board store", () => {
  it("round-trips tasks.json and exports csv", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-plan-"));
    tempDirs.push(root);
    const board = createEmptyBoard({
      title: "Auth fix",
      goal: "Fix login redirect",
      tasks: [
        { id: "t1", title: "Reproduce", status: "done" },
        { id: "t2", title: "Patch", status: "in_progress" },
      ],
    });
    await savePlanBoard(root, board);
    const loaded = await loadPlanBoard(root);
    expect(loaded?.title).toBe("Auth fix");
    expect(loaded?.tasks).toHaveLength(2);
    const csvPath = await exportTasksCsv(root, loaded!);
    expect(csvPath).toContain("tasks.csv");
    const csv = await readFile(path.join(root, csvPath), "utf8");
    expect(csv).toContain("t1,done,Reproduce");
  });

  it("loads legacy .xiocode/plan when .claude/plan is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-plan-legacy-"));
    tempDirs.push(root);
    const legacyDir = path.join(root, LEGACY_PLAN_DIR);
    await mkdir(legacyDir, { recursive: true });
    const board = createEmptyBoard({ title: "Legacy", goal: "old path" });
    await writeFile(
      path.join(legacyDir, "tasks.json"),
      `${JSON.stringify({ ...board, prd_path: `${LEGACY_PLAN_DIR}/prd.md` }, null, 2)}\n`,
      "utf8",
    );
    const loaded = await loadPlanBoard(root);
    expect(loaded?.title).toBe("Legacy");
    // New writes still go to Claude tree.
    await savePlanBoard(root, loaded!);
    expect(await readFile(path.join(root, PLAN_DIR, "tasks.json"), "utf8")).toContain("Legacy");
  });

  it("parses legacy-ish task payloads", () => {
    const board = parsePlanBoard({
      title: "X",
      goal: "Y",
      tasks: [{ id: "a", title: "One", status: "todo" }, { title: "Two", status: "wip" }],
    });
    expect(board.tasks[0]?.status).toBe("pending");
    expect(board.tasks[1]?.status).toBe("in_progress");
    expect(board.tasks[1]?.id).toBe("t2");
  });
});

describe("formatTasklistWidget", () => {
  it("renders progress glyphs", () => {
    const lines = formatTasklistWidget(createEmptyBoard({
      title: "Demo",
      goal: "Ship plan board",
      tasks: [
        { id: "t1", title: "Done item", status: "done" },
        { id: "t2", title: "Active", status: "in_progress" },
        { id: "t3", title: "Later", status: "pending" },
      ],
    }));
    expect(lines[0]).toContain("1/3");
    expect(lines.some((line) => line.includes("✓") && line.includes("t1"))).toBe(true);
    expect(lines.some((line) => line.includes("►") && line.includes("t2"))).toBe(true);
  });
});

describe("formatPlanAck", () => {
  it("keeps tool replies short without dumping every task title", () => {
    const board = createEmptyBoard({
      title: "Demo",
      goal: "Ship",
      tasks: [
        { id: "t1", title: "Done item", status: "done" },
        { id: "t2", title: "Active long title that should not bloat ack", status: "in_progress" },
      ],
    });
    const ack = formatPlanAck("update", board, "t2→in_progress");
    expect(ack).toBe("plan update ok · 1/2 · ►t2 · t2→in_progress");
    expect(ack).not.toContain("Active long title");
    const list = formatPlanListCompact(board);
    expect(list).toContain("t1");
    expect(list.split("\n").length).toBeLessThanOrEqual(4);
  });
});

describe("plan tool", () => {
  it("bootstraps docs, set_tasks, updates status, refreshes widget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-plan-tool-"));
    tempDirs.push(root);
    const widgets: Record<string, readonly string[]> = {};
    const tool = createPlanTool({
      workspaceRoot: root,
      sink: {
        setWidget(key, content) {
          if (content) widgets[key] = content;
          else delete widgets[key];
        },
        setStatus() {},
      },
    });

    const boot = await tool.execute("1", {
      action: "bootstrap",
      goal: "Add plan board MVP",
      title: "Plan MVP",
    });
    expect(boot.isError).not.toBe(true);
    expect(boot.content[0]?.text).toMatch(/^plan bootstrap ok · 0\/0/);
    expect(boot.content[0]?.text).not.toContain("goal:");
    expect(await loadPlanBoard(root)).toBeDefined();
    expect(await readFile(path.join(root, ".claude/plan/prd.md"), "utf8")).toContain("目标");

    const set = await tool.execute("2", {
      action: "set_tasks",
      tasks: [
        { id: "t1", title: "Write PRD", status: "done" },
        { id: "t2", title: "Wire TUI", status: "pending" },
      ],
    });
    expect(set.content[0]?.text).toMatch(/plan set_tasks ok · 1\/2 · 2 tasks/);
    const upd = await tool.execute("3", { action: "update", id: "t2", status: "in_progress" });
    expect(upd.content[0]?.text).toBe("plan update ok · 1/2 · ►t2 · t2→in_progress");
    const board = await loadPlanBoard(root);
    expect(board?.tasks.find((t) => t.id === "t2")?.status).toBe("in_progress");
    expect(widgets.tasklist?.some((line) => line.includes("t2"))).toBe(true);

    const csv = await tool.execute("4", { action: "export_csv" });
    expect(csv.content[0]?.text).toMatch(/plan export_csv ok/);
    expect(csv.content[0]?.text).toContain("tasks.csv");
  });
});

describe("registerPlanCapability", () => {
  it("registers plan tool and /plan command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-plan-reg-"));
    tempDirs.push(root);
    const host = new ExtensionHost();
    await registerPlanCapability(host, { workspaceRoot: root });
    expect(host.getTool("plan")).toBeDefined();
    expect(host.getCommand("plan")).toBeDefined();
    const text = await host.runCommand("plan");
    expect(String(text)).toMatch(/no plan/i);
  });

  it("injects ultra parallel-plan addendum when Trellis is present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-plan-ultra-"));
    tempDirs.push(root);
    await mkdir(path.join(root, ".trellis", "scripts"), { recursive: true });
    await writeFile(path.join(root, ".trellis", "scripts", "task.py"), "# stub\n");
    const host = new ExtensionHost();
    host.setThinkingLevel("ultra");
    await registerPlanCapability(host, { workspaceRoot: root });
    const results = await host.emit("before_agent_start", {
      prompt: "big multi-file refactor",
      systemPrompt: "You are XioCode.",
    });
    const last = results.at(-1) as { systemPrompt?: string } | undefined;
    expect(last?.systemPrompt).toContain("## Ultra → Trellis parallel-plan.v1");
    expect(last?.systemPrompt).toContain("parallel_draft");
  });

  it("emits explicit degrade notice on ultra without Trellis", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-plan-degrade-"));
    tempDirs.push(root);
    const host = new ExtensionHost();
    host.setThinkingLevel("ultra");
    await registerPlanCapability(host, { workspaceRoot: root });
    const results = await host.emit("before_agent_start", {
      prompt: "refactor",
      systemPrompt: "You are XioCode.",
    });
    const last = results.at(-1) as { systemPrompt?: string } | undefined;
    expect(last?.systemPrompt).toMatch(/并行写码派发不可用/);
    expect(last?.systemPrompt).not.toContain("## Ultra → Trellis parallel-plan.v1");
  });
});

describe("parallel_draft", () => {
  it("writes parallel-plan.v1 and returns Trellis handoff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-plan-pd-"));
    tempDirs.push(root);
    const tool = createPlanTool({ workspaceRoot: root });
    const result = await tool.execute("pd1", {
      action: "parallel_draft",
      parent_dir: "07-22-parent",
      parallel_plan_json: JSON.stringify({
        version: "parallel-plan.v1",
        children: [
          {
            slug: "a",
            title: "A",
            depends_on: [],
            isolation: "worktree",
            write_scope: ["src/a/**"],
          },
          {
            slug: "b",
            title: "B",
            depends_on: ["a"],
            isolation: "shared",
          },
        ],
      }),
    });
    expect(result.content[0]?.text).toMatch(/parallel_draft ok/);
    expect(result.content[0]?.text).toContain("plan-import");
    const raw = await readFile(path.join(root, ".claude/plan/parallel-plan.json"), "utf8");
    expect(JSON.parse(raw).version).toBe("parallel-plan.v1");
  });

  it("rejects dependency cycles at draft time", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-plan-cycle-"));
    tempDirs.push(root);
    const tool = createPlanTool({ workspaceRoot: root });
    const result = await tool.execute("pd2", {
      action: "parallel_draft",
      parallel_plan_json: JSON.stringify({
        version: "parallel-plan.v1",
        children: [
          { slug: "x", title: "X", depends_on: ["y"], isolation: "worktree", write_scope: ["src/x/**"] },
          { slug: "y", title: "Y", depends_on: ["x"], isolation: "worktree", write_scope: ["src/y/**"] },
        ],
      }),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/dependency cycle: x, y/);
  });
});

describe("parallel_dispatch", () => {
  const PLAN = {
    version: "parallel-plan.v1",
    parent: { slug: "feat", title: "Feat" },
    children: [
      { slug: "a", title: "A", depends_on: [], isolation: "worktree", write_scope: ["src/a/**"] },
    ],
  };

  async function makeTrellisFixture(logCommands: boolean): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-plan-dispatch-"));
    tempDirs.push(root);
    await mkdir(path.join(root, ".git"), { recursive: true });
    await mkdir(path.join(root, ".claude", "plan"), { recursive: true });
    await writeFile(
      path.join(root, ".claude", "plan", "parallel-plan.json"),
      JSON.stringify(PLAN),
      "utf8",
    );
    const scripts = path.join(root, ".trellis", "scripts");
    await mkdir(scripts, { recursive: true });
    if (logCommands) {
      // Stub task.py: append argv to calls.log; plan-import prints the parent
      // dir on stdout (the chaining contract the real script follows).
      await writeFile(
        path.join(scripts, "task.py"),
        [
          "import sys, pathlib",
          "root = pathlib.Path(__file__).resolve().parents[2]",
          "with (root / 'calls.log').open('a') as f:",
          "    f.write(' '.join(sys.argv[1:]) + '\\n')",
          "if sys.argv[1] == 'plan-import':",
          "    print('.trellis/tasks/07-26-feat')",
          "",
        ].join("\n"),
        "utf8",
      );
    } else {
      await writeFile(path.join(scripts, "task.py"), "raise SystemExit(1)\n", "utf8");
    }
    return root;
  }

  it("runs import -> dispatch -> integrate -> merge after both confirmations", async () => {
    const root = await makeTrellisFixture(true);
    const questions: string[] = [];
    const tool = createPlanTool({
      workspaceRoot: root,
      ask: async (question) => {
        questions.push(question);
        return true;
      },
    });
    const result = await tool.execute("dp1", { action: "parallel_dispatch" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toMatch(/parallel dispatch complete/);
    expect(questions).toHaveLength(2);
    const calls = (await readFile(path.join(root, "calls.log"), "utf8")).trim().split("\n");
    expect(calls).toEqual([
      "plan-import feat .claude/plan/parallel-plan.json --yes",
      "dispatch-ready .trellis/tasks/07-26-feat --yes",
      "integrate .trellis/tasks/07-26-feat",
      "integrate .trellis/tasks/07-26-feat --yes",
    ]);
  });

  it("declining the first gate runs nothing and returns the manual handoff", async () => {
    const root = await makeTrellisFixture(true);
    const tool = createPlanTool({
      workspaceRoot: root,
      ask: async () => false,
    });
    const result = await tool.execute("dp2", { action: "parallel_dispatch" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/declined/);
    expect(result.content[0]?.text).toContain("plan-import");
    await expect(readFile(path.join(root, "calls.log"), "utf8")).rejects.toThrow();
  });

  it("declining the merge gate keeps the integration branch and stops", async () => {
    const root = await makeTrellisFixture(true);
    let asked = 0;
    const tool = createPlanTool({
      workspaceRoot: root,
      ask: async () => {
        asked += 1;
        return asked === 1;
      },
    });
    const result = await tool.execute("dp3", { action: "parallel_dispatch" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toMatch(/final merge skipped/);
    const calls = (await readFile(path.join(root, "calls.log"), "utf8")).trim().split("\n");
    expect(calls).toHaveLength(3);
    expect(calls.at(-1)).toBe("integrate .trellis/tasks/07-26-feat");
  });

  it("errors without an ask channel instead of dispatching silently", async () => {
    const root = await makeTrellisFixture(true);
    const tool = createPlanTool({ workspaceRoot: root });
    const result = await tool.execute("dp4", { action: "parallel_dispatch" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/no interactive confirm channel/);
    await expect(readFile(path.join(root, "calls.log"), "utf8")).rejects.toThrow();
  });

  it("surfaces a failing task.py as an error with output tail", async () => {
    const root = await makeTrellisFixture(false);
    const tool = createPlanTool({
      workspaceRoot: root,
      ask: async () => true,
    });
    const result = await tool.execute("dp5", { action: "parallel_dispatch" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/plan-import failed/);
  });
});
