import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatDoneContractFeedback, runDoneContract } from "./done-contract.ts";
import { withoutStatCaches } from "./evidence.ts";
import { hashContent, verifyWriteBack } from "./write-back.ts";
import { createBuiltinTools } from "../tools/builtin.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("runDoneContract", () => {
  it("passes when commands exit 0", async () => {
    const result = await runDoneContract({
      commands: [{ name: "true", argv: ["true"] }],
    });
    expect(result.passed).toBe(true);
    expect(result.summary).toContain("PASS");
  });

  it("fails when a command exits non-zero", async () => {
    const result = await runDoneContract({
      commands: [{ name: "false", argv: ["false"] }],
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toContain("FAIL");
  });

  it("formats failure feedback with Fix guidance", async () => {
    const result = await runDoneContract({
      commands: [{ name: "false", argv: ["false"] }],
    });
    const feedback = formatDoneContractFeedback(result);
    expect(feedback).toContain("DONE CONTRACT FAILED");
    expect(feedback).toMatch(/Fix:/i);
    expect(feedback.toLowerCase()).toMatch(/exit 0|do not claim/);
  });
});

describe("runDoneContract evidence reuse", () => {
  const READS_INPUT = ["node", "-e", "require('fs').readFileSync('input.txt')"];

  async function workspace(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-evidence-"));
    tempDirs.push(root);
    await writeFile(path.join(root, "input.txt"), "one\n", "utf8");
    await writeFile(path.join(root, "other.txt"), "other\n", "utf8");
    return root;
  }
  const check = (cwd: string, argv: readonly string[] = READS_INPUT) =>
    runDoneContract({ commands: [{ name: "check", argv }] }, { cwd });

  it("keeps an earlier pass while nothing changed, and runs again once something did", async () => {
    const cwd = await workspace();
    const first = await check(cwd);
    // Built-in supervisor (no kernel): there is no evidence, every call runs the command.
    if (!first.results[0]?.evidence) return;
    expect(first.results[0].evidence).toEqual({ reused: false });

    const second = await check(cwd);
    expect(second.results[0]?.evidence).toMatchObject({ reused: true, previous: { status: "fresh", basis: "tree_unchanged" } });
    expect(second.summary).toBe("done contract: PASS [check:pass (not re-run: nothing in the workspace has changed since it passed)]");

    await writeFile(path.join(cwd, "input.txt"), "two\n", "utf8");
    const third = await check(cwd);
    expect(third.results[0]?.evidence?.reused).toBe(false);
    const previous = third.results[0]?.evidence?.previous;
    if (previous?.status === "stale") {
      expect(third.summary).toContain("check:pass (re-run: input.txt changed since the last pass)");
    } else {
      // A filesystem that does not record access times: the read set is not observed.
      expect(previous).toMatchObject({ status: "unknown", reason: "reads_unobserved" });
    }
  });

  it("runs again when a file the command did not read changed, because a cache may hide the dependency", async () => {
    const cwd = await workspace();
    const first = await check(cwd);
    if (!first.results[0]?.evidence) return;
    await writeFile(path.join(cwd, "other.txt"), "changed\n", "utf8");
    const second = await check(cwd);
    expect(second.results[0]?.evidence).toMatchObject({ reused: false, previous: { status: "unknown" } });
    expect(second.summary).toContain("re-run: files changed since the last pass, and it cannot be shown that this command does not depend on them");
  });

  it("never keeps a failure", async () => {
    const cwd = await workspace();
    const failing = ["node", "-e", "process.exit(2)"];
    const first = await check(cwd, failing);
    const second = await check(cwd, failing);
    expect(first.passed).toBe(false);
    expect(second.results[0]).toMatchObject({ passed: false, exitCode: 2 });
    expect(second.results[0]?.evidence?.reused ?? false).toBe(false);
  });

  it("takes the bytecode cache out of the way for Python runners only", () => {
    const python = withoutStatCaches(["/usr/bin/python3", "-m", "pytest"], { PATH: "/usr/bin" });
    expect(python.statCaches).toBe("ruled_out");
    expect(python.env.PYTHONDONTWRITEBYTECODE).toBe("1");
    const cacheDir = python.env.PYTHONPYCACHEPREFIX!;
    expect(existsSync(cacheDir)).toBe(true);
    python.dispose();
    expect(existsSync(cacheDir)).toBe(false);

    const other = withoutStatCaches(["npm", "test"], { PATH: "/usr/bin" });
    expect(other.statCaches).toBeUndefined();
    expect(other.env).toEqual({ PATH: "/usr/bin" });
  });
});

describe("verifyWriteBack", () => {
  it("confirms matching content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-wb-"));
    tempDirs.push(root);
    const file = path.join(root, "a.txt");
    await writeFile(file, "hello", "utf8");
    const result = await verifyWriteBack(file, "hello");
    expect(result.ok).toBe(true);
    expect(result.actualHash).toBe(hashContent("hello"));
  });

  it("detects mismatch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-wb-"));
    tempDirs.push(root);
    const file = path.join(root, "a.txt");
    await writeFile(file, "hello", "utf8");
    const result = await verifyWriteBack(file, "other");
    expect(result.ok).toBe(false);
  });
});

describe("builtin write constraints", () => {
  it("rejects writes outside workspace and verifies write-back", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-ws-"));
    tempDirs.push(root);
    const tools = createBuiltinTools({ cwd: root, workspaceRoot: root });
    const write = tools.find((tool) => tool.name === "write");
    expect(write).toBeDefined();

    const blocked = await write!.execute("1", {
      path: path.join(os.tmpdir(), "outside-xio.txt"),
      content: "nope",
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]?.text).toContain("escapes workspace");

    const ok = await write!.execute("2", { path: "inside.txt", content: "ok\n" });
    expect(ok.isError).toBeFalsy();
    expect(await readFile(path.join(root, "inside.txt"), "utf8")).toBe("ok\n");
    expect(ok.content[0]?.text).toContain("write-back ok");
  });
});
