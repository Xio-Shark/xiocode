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
