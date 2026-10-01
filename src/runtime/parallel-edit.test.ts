import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitOk } from "../../extensions/xio-sandbox/src/git.ts";
import {
  createParallelEditTool,
  createWorkerRunner,
  formatParallelEditReport,
  runParallelEdit,
  type RunWorker,
} from "./parallel-edit.ts";
import { KernelSession } from "./process/kernel-session.ts";
import type { LlmClient } from "./types.ts";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function repo(): Promise<Readonly<{ kernel: KernelSession; root: string }>> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xio-parallel-")));
  const root = path.join(base, "ws");
  fs.mkdirSync(root);
  await gitOk(root, ["init"]);
  await gitOk(root, ["config", "user.email", "xio@test"]);
  await gitOk(root, ["config", "user.name", "xio"]);
  for (const name of ["a.txt", "b.txt", "shared.txt"]) fs.writeFileSync(path.join(root, name), `${name} v0\n`);
  await gitOk(root, ["add", "."]);
  await gitOk(root, ["commit", "-m", "init"]);
  const kernel = await KernelSession.open({ sessionId: "parallel", workspaceRoot: root, domainPath: path.join(base, "domain") });
  cleanups.push(() => {
    kernel.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { kernel, root };
}

const read = (root: string, name: string) => fs.readFileSync(path.join(root, name), "utf8");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Scripted workers: each task name maps to what it does in its fork, after an optional delay. */
function scripted(steps: Record<string, Readonly<{ delayMs?: number; act: (fork: string) => void; fail?: boolean }>>): RunWorker {
  return async ({ task, forkRoot }) => {
    const step = steps[task.name]!;
    await sleep(step.delayMs ?? 0);
    step.act(forkRoot);
    return step.fail ? { success: false, summary: "gave up" } : { success: true, summary: `${task.name} done` };
  };
}

describe("runParallelEdit", () => {
  it("applies workers that touched different files", async () => {
    const { kernel, root } = await repo();
    const reports = await runParallelEdit(
      [{ name: "A", instruction: "edit a" }, { name: "B", instruction: "edit b" }],
      kernel,
      scripted({
        A: { act: (fork) => fs.writeFileSync(path.join(fork, "a.txt"), "a by A\n") },
        B: { act: (fork) => fs.writeFileSync(path.join(fork, "b.txt"), "b by B\n") },
      }),
    );
    expect(reports.map((r) => r.status)).toEqual(["committed", "committed"]);
    expect(read(root, "a.txt")).toBe("a by A\n");
    expect(read(root, "b.txt")).toBe("b by B\n");
    expect(fs.readdirSync(path.join(kernel.domainPath, "forks"))).toEqual([]);
    expect(formatParallelEditReport(reports)).toContain("2/2 task(s) applied");
  });

  it("applies the first writer of a shared file and reports the second as a conflict", async () => {
    const { kernel, root } = await repo();
    const reports = await runParallelEdit(
      [{ name: "slow", instruction: "x" }, { name: "fast", instruction: "y" }],
      kernel,
      scripted({
        slow: { delayMs: 400, act: (fork) => fs.writeFileSync(path.join(fork, "shared.txt"), "slow\n") },
        fast: { act: (fork) => fs.writeFileSync(path.join(fork, "shared.txt"), "fast\n") },
      }),
    );
    const [slow, fast] = reports;
    expect(fast?.status).toBe("committed");
    expect(slow).toMatchObject({ status: "conflict", lostTo: ["fast"] });
    expect(slow?.conflicts).toEqual([expect.objectContaining({ path: "shared.txt", kind: "write_write" })]);
    expect(read(root, "shared.txt")).toBe("fast\n");
    expect(formatParallelEditReport(reports)).toContain("slow: NOT applied — conflict after fast was applied: shared.txt (both changed it)");
  });

  it("reports a task whose input changed under it (read_write)", async () => {
    const { kernel, root } = await repo();
    const reports = await runParallelEdit(
      [{ name: "reader", instruction: "x" }, { name: "writer", instruction: "y" }],
      kernel,
      scripted({
        // Derives b.txt from shared.txt, which "writer" changes and commits first.
        reader: {
          delayMs: 400,
          act: (fork) => fs.writeFileSync(path.join(fork, "b.txt"), fs.readFileSync(path.join(fork, "shared.txt"), "utf8").toUpperCase()),
        },
        writer: { act: (fork) => fs.writeFileSync(path.join(fork, "shared.txt"), "new shared\n") },
      }),
    );
    const reader = reports[0]!;
    if (reader.status === "conflict") {
      expect(reader.conflicts).toEqual([expect.objectContaining({ path: "shared.txt", kind: "read_write" })]);
      expect(read(root, "b.txt")).toBe("b.txt v0\n");
    } else {
      // Read tracking uses access times; on a noatime filesystem it is unobserved and only writes are checked.
      expect(reader.status).toBe("committed");
    }
    expect(read(root, "shared.txt")).toBe("new shared\n");
  });

  it("does not overwrite a direct change to the workspace (external_write) and discards failed workers", async () => {
    const { kernel, root } = await repo();
    const reports = await runParallelEdit(
      [{ name: "late", instruction: "x" }, { name: "broken", instruction: "y" }],
      kernel,
      scripted({
        late: {
          act: (fork) => {
            fs.writeFileSync(path.join(root, "a.txt"), "edited by hand meanwhile\n");
            fs.writeFileSync(path.join(fork, "a.txt"), "late\n");
          },
        },
        broken: { fail: true, act: (fork) => fs.writeFileSync(path.join(fork, "b.txt"), "half done\n") },
      }),
    );
    expect(reports[0]).toMatchObject({ status: "conflict" });
    expect(reports[0]?.conflicts).toEqual([expect.objectContaining({ path: "a.txt", kind: "external_write" })]);
    expect(reports[1]).toMatchObject({ status: "failed" });
    expect(read(root, "a.txt")).toBe("edited by hand meanwhile\n");
    expect(read(root, "b.txt")).toBe("b.txt v0\n");
    expect(fs.readdirSync(path.join(kernel.domainPath, "forks"))).toEqual([]);
  });
});

describe("parallel_edit tool", () => {
  it("runs real worker agents in their forks and applies their edits", async () => {
    const { kernel, root } = await repo();
    // Each worker writes the file named in its instruction, then reports.
    const client: LlmClient = {
      async complete(request) {
        const instruction = request.messages.find((m) => m.role === "user")?.content ?? "";
        const target = /write (\S+)/.exec(instruction)?.[1] ?? "unknown.txt";
        if (!request.messages.some((m) => m.role === "tool")) {
          return { content: "", toolCalls: [{ id: `w-${target}`, name: "write", arguments: { path: target, content: `${target} by worker\n` } }] };
        }
        return { content: `wrote ${target}`, toolCalls: [] };
      },
    };
    const tool = createParallelEditTool({
      getKernel: () => kernel,
      runWorker: createWorkerRunner({
        getClient: () => client,
        getModel: () => ({ provider: "test", id: "stub" }),
        getProviderApi: () => "openai-completions",
        maxTurns: 4,
      }),
    });
    const result = await tool.execute("call-1", {
      tasks: [{ name: "one", instruction: "write new-one.txt" }, { name: "two", instruction: "write new-two.txt" }],
    });
    const text = result.content.map((part) => part.text).join("");
    expect(result.isError).toBe(false);
    expect(text).toContain("2/2 task(s) applied");
    expect(read(root, "new-one.txt")).toBe("new-one.txt by worker\n");
    expect(read(root, "new-two.txt")).toBe("new-two.txt by worker\n");
  });

  it("records each worker's observations and edits, with the fork path taken out", async () => {
    const { kernel, root } = await repo();
    // read a.txt, then write the target: one observation followed by one mutation.
    const client: LlmClient = {
      async complete(request) {
        const tools = request.messages.filter((m) => m.role === "tool").length;
        if (tools === 0) return { content: "", toolCalls: [{ id: "r", name: "read", arguments: { path: "a.txt" } }] };
        if (tools === 1) return { content: "", toolCalls: [{ id: "w", name: "write", arguments: { path: "out.txt", content: "x\n" } }] };
        return { content: "done", toolCalls: [] };
      },
    };
    const forks: string[] = [];
    const runWorker = createWorkerRunner({
      getClient: () => client,
      getModel: () => ({ provider: "test", id: "stub" }),
      getProviderApi: () => "openai-completions",
      maxTurns: 4,
    });
    const reports = await runParallelEdit(
      [{ name: "solo", instruction: "go" }],
      kernel,
      (input) => {
        forks.push(input.forkRoot);
        return runWorker(input);
      },
    );
    expect(reports[0]?.status).toBe("committed");
    expect(reports[0]?.observations?.map((o) => [o.kind, o.tool])).toEqual([["observe", "read"], ["mutate", "write"]]);
    expect(JSON.stringify(reports[0]?.observations)).not.toContain(forks[0]);
    expect(reports[0]?.usage).toBeDefined();
    expect(read(root, "out.txt")).toBe("x\n");
  });

  type ScriptedCall = Readonly<{ name: string; arguments: Record<string, unknown> }>;

  /**
   * Real workers (the builtin file tools), each driven by a script. `reader` gives its final answer last,
   * so `writer` commits first.
   */
  async function readerAgainstWriter(
    files: Record<string, string>,
    scripts: Readonly<{ reader: readonly ScriptedCall[]; writer: readonly ScriptedCall[] }>,
  ) {
    const { kernel, root } = await repo();
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
    await gitOk(root, ["add", "."]);
    await gitOk(root, ["commit", "-m", "fixture"]);
    const modelCalls: Record<string, number> = { reader: 0, writer: 0 };
    const client: LlmClient = {
      async complete(request) {
        const task = String(request.messages.find((m) => m.role === "user")?.content) as "reader" | "writer";
        modelCalls[task] = (modelCalls[task] ?? 0) + 1;
        const done = request.messages.filter((m) => m.role === "tool").length;
        const next = scripts[task][done];
        if (next) return { content: "", toolCalls: [{ id: `${task}-${done}`, ...next }] };
        if (task === "reader") await sleep(500);
        return { content: `${task} done`, toolCalls: [] };
      },
    };
    const runWorker = createWorkerRunner({
      getClient: () => client,
      getModel: () => ({ provider: "test", id: "stub" }),
      getProviderApi: () => "openai-completions",
      maxTurns: 4,
    });
    const reports = await runParallelEdit([{ name: "reader", instruction: "reader" }, { name: "writer", instruction: "writer" }], kernel, runWorker);
    return { root, reader: reports[0]!, writer: reports[1]!, reports, modelCalls };
  }

  const TWO_LINES = { "shared.txt": "line one\nline two\n" };
  const changeSecondLine: readonly ScriptedCall[] = [
    { name: "read", arguments: { path: "shared.txt" } },
    { name: "edit", arguments: { path: "shared.txt", old_string: "line two", new_string: "LINE TWO" } },
  ];
  const readThenWriteOut = (readArgs: Record<string, unknown>): readonly ScriptedCall[] =>
    [{ name: "read", arguments: readArgs }, { name: "write", arguments: { path: "out.txt", content: "from reader\n" } }];

  it("applies a task whose file was changed elsewhere than where it looked, without another model call", async () => {
    // reader saw only the first line of shared.txt; writer changed the second.
    const { root, reader, writer, reports, modelCalls } = await readerAgainstWriter(TWO_LINES, { reader: readThenWriteOut({ path: "shared.txt", limit: 1 }), writer: changeSecondLine });
    expect(writer.status).toBe("committed");
    expect(reader.status).toBe("committed");
    // Read tracking uses access times; on a noatime filesystem the file-level check never sees the read.
    if (reader.validation === "write_only") return;
    expect(reader.validation).toBe("observations");
    expect(read(root, "out.txt")).toBe("from reader\n");
    expect(read(root, "shared.txt")).toBe("line one\nLINE TWO\n");
    expect(modelCalls.reader).toBe(3);
    expect(formatParallelEditReport(reports)).toContain("returned the same results");
  });

  it("keeps the conflict when what the task read is different now, and says which step", async () => {
    const { root, reader, reports } = await readerAgainstWriter(TWO_LINES, { reader: readThenWriteOut({ path: "shared.txt" }), writer: changeSecondLine });
    if (reader.validation === "write_only") return;
    expect(reader.status).toBe("conflict");
    expect(reader.conflicts).toEqual([expect.objectContaining({ path: "shared.txt", kind: "read_write" })]);
    expect(reader.observation).toEqual({ attempted: true, divergedAt: 0, reason: "observation_changed" });
    expect(fs.existsSync(path.join(root, "out.txt"))).toBe(false);
    expect(formatParallelEditReport(reports)).toContain("step 1 (read shared.txt) returns something different from what the task saw");
  });

  it("keeps the conflict when an edit would now report a reference the task never saw", async () => {
    // reader renames an exported function; the edit's result lists the other files that refer to it.
    // writer adds a new file that calls the old name and commits first.
    const { root, reader, reports } = await readerAgainstWriter(
      { "lib.ts": "export function oldName() {\n  return 1;\n}\n", "use.ts": "import { oldName } from './lib';\noldName();\n" },
      {
        reader: [
          { name: "read", arguments: { path: "lib.ts" } },
          { name: "edit", arguments: { path: "lib.ts", old_string: "export function oldName()", new_string: "export function newName()" } },
        ],
        writer: [{ name: "write", arguments: { path: "use2.ts", content: "import { oldName } from './lib';\nexport const two = oldName();\n" } }],
      },
    );
    if (reader.validation === "write_only") return;
    expect(reader.status).toBe("conflict");
    // Step 1 (the read of lib.ts) is unchanged; step 2 is the edit, whose result now names use2.ts as well.
    expect(reader.observation).toEqual({ attempted: true, divergedAt: 1, reason: "observation_changed" });
    expect(fs.readFileSync(path.join(root, "lib.ts"), "utf8")).toContain("oldName");
    expect(formatParallelEditReport(reports)).toContain("step 2 (edit lib.ts) returns something different from what the task saw");
  });

  it("validates its input and refuses under write confinement", async () => {
    const { kernel } = await repo();
    const tool = createParallelEditTool({ getKernel: () => kernel, runWorker: async () => ({ success: true, summary: "" }) });
    const one = await tool.execute("c", { tasks: [{ name: "a", instruction: "x" }] });
    expect(one.isError).toBe(true);
    const dup = await tool.execute("c", { tasks: [{ name: "a", instruction: "x" }, { name: "a", instruction: "y" }] });
    expect(dup.content[0]?.text).toContain("unique");
    const none = createParallelEditTool({ getKernel: () => undefined, runWorker: async () => ({ success: true, summary: "" }) });
    expect((await none.execute("c", { tasks: [] })).content[0]?.text).toContain("needs the kernel session");
  });
});
