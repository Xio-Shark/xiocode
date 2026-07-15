import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatDoneContractFeedback, runDoneContract } from "./done-contract.ts";
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
