import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyNormsWrites,
  formatNormsConfirmDetail,
  resolveNormsAllowlistPath,
  writePendingNormsOffer,
  readPendingNormsOffer,
} from "../src/retrospective/norms-write.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("norms allowlist", () => {
  it("allows AGENTS.md / CLAUDE.md / .trellis/spec/** and rejects escape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-norms-ws-"));
    tempDirs.push(root);
    await mkdir(path.join(root, ".trellis", "spec"), { recursive: true });

    expect(resolveNormsAllowlistPath(root, "AGENTS.md").ok).toBe(true);
    expect(resolveNormsAllowlistPath(root, "CLAUDE.md").ok).toBe(true);
    expect(resolveNormsAllowlistPath(root, ".trellis/spec/foo.md").ok).toBe(true);
    expect(resolveNormsAllowlistPath(root, ".trellis/tasks/x.md").ok).toBe(false);
    expect(resolveNormsAllowlistPath(root, "../outside.md").ok).toBe(false);
    expect(resolveNormsAllowlistPath(root, ".cursor/rules/x.mdc").ok).toBe(false);
  });

  it("does not write when applying rejected escape paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-norms-ws-"));
    tempDirs.push(root);
    const result = await applyNormsWrites({
      workspaceRoot: root,
      files: [
        { relativePath: "AGENTS.md", content: "# ok\n" },
        { relativePath: ".trellis/tasks/nope.md", content: "bad\n" },
      ],
    });
    expect(result.written).toEqual([]);
    expect(result.rejected.length).toBeGreaterThan(0);
    await expect(readFile(path.join(root, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  it("writes allowlisted files with bak on accept", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-norms-ws-"));
    tempDirs.push(root);
    await writeFile(path.join(root, "AGENTS.md"), "old\n", "utf8");
    const result = await applyNormsWrites({
      workspaceRoot: root,
      files: [{ relativePath: "AGENTS.md", content: "new\n", summary: "update agents" }],
      now: () => 99,
    });
    expect(result.written).toEqual(["AGENTS.md"]);
    expect(result.backups.some((b) => b.endsWith(".bak-99"))).toBe(true);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("new\n");
  });

  it("pending offer round-trips without writing workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-norms-ws-"));
    tempDirs.push(root);
    const pendingPath = path.join(root, "pending-norms.json");
    await writePendingNormsOffer({
      schema_version: "xio-pending-norms.v1",
      created_at: new Date().toISOString(),
      run_id: "run-1",
      workspace_root: root,
      files: [{ relativePath: "CLAUDE.md", content: "# draft\n" }],
    }, pendingPath);
    const pending = await readPendingNormsOffer(pendingPath);
    expect(pending?.files[0]?.relativePath).toBe("CLAUDE.md");
    await expect(readFile(path.join(root, "CLAUDE.md"), "utf8")).rejects.toThrow();
    expect(formatNormsConfirmDetail(pending!.files)).toContain("CLAUDE.md");
  });
});
