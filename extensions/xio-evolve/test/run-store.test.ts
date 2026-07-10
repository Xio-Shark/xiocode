import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RunStore } from "../src/run-store.ts";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("RunStore", () => {
  it("creates a run directory and writes metadata", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-runs-"));
    const store = new RunStore({ root: tempDir, now: () => new Date("2026-06-02T00:00:00.000Z"), randomId: () => "abcdef123456" });

    const run = await store.createRun({ provider: "deepseek", model: "chat" });
    const metadata = JSON.parse(await readFile(path.join(run.path, "metadata.json"), "utf8")) as Record<string, unknown>;

    expect(run.run_id).toContain("run-2026-06-02T00-00-00-000Z");
    expect(metadata.provider).toBe("deepseek");
    expect(metadata.model).toBe("chat");
  });

  it("lists recent runs by started_at descending", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-runs-"));
    const store = new RunStore({ root: tempDir, randomId: () => "id" });
    await store.createRun({ run_id: "old", started_at: "2026-01-01T00:00:00.000Z" });
    await store.createRun({ run_id: "new", started_at: "2026-02-01T00:00:00.000Z" });

    const recent = await store.listRecent(1);

    expect(recent[0]?.run_id).toBe("new");
  });
});
