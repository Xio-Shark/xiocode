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
    expect(result.status).toBe("ok");
    expect(result.written).toEqual(["AGENTS.md"]);
    expect(result.backups.some((b) => b.endsWith(".bak-99"))).toBe(true);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("new\n");
  });

  it("rejects symlink targets and leaves outside canaries untouched", async () => {
    const { symlink } = await import("node:fs/promises");
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-norms-link-"));
    tempDirs.push(root);
    const outside = path.join(root, "..", `outside-${path.basename(root)}.md`);
    await writeFile(outside, "outside\n", "utf8");
    tempDirs.push(outside);
    await symlink(outside, path.join(root, "AGENTS.md"));
    const result = await applyNormsWrites({
      workspaceRoot: root,
      files: [{ relativePath: "AGENTS.md", content: "pwned\n" }],
    });
    expect(result.written).toEqual([]);
    expect(result.status).toBe("rejected");
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  it("rejects symlink escape targets before any publish and leaves canaries untouched", async () => {
    const { symlink, mkdir } = await import("node:fs/promises");
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-norms-rb-"));
    tempDirs.push(root);
    await mkdir(path.join(root, ".trellis", "spec"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "keep-agents\n", "utf8");
    await writeFile(path.join(root, ".trellis", "spec", "ok.md"), "keep-spec\n", "utf8");
    const outside = path.join(root, "..", `canary-${path.basename(root)}.txt`);
    await writeFile(outside, "canary\n", "utf8");
    tempDirs.push(outside);
    // Second allowlisted path escapes through a symlink directory.
    await symlink(path.dirname(outside), path.join(root, ".trellis", "spec", "linked"), "dir");

    const result = await applyNormsWrites({
      workspaceRoot: root,
      files: [
        { relativePath: "AGENTS.md", content: "new-agents\n" },
        { relativePath: ".trellis/spec/linked/canary.txt", content: "pwned\n" },
      ],
    });
    expect(result.written).toEqual([]);
    expect(result.status).toBe("rejected");
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("keep-agents\n");
    expect(await readFile(outside, "utf8")).toBe("canary\n");
  });

  it("rolls back earlier publishes when a later publish validation fails", async () => {
    const { mkdir } = await import("node:fs/promises");
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-norms-pub-rb-"));
    tempDirs.push(root);
    await mkdir(path.join(root, ".trellis", "spec"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "keep-agents\n", "utf8");
    await writeFile(path.join(root, ".trellis", "spec", "ok.md"), "keep-spec\n", "utf8");
    let publishes = 0;

    const result = await applyNormsWrites({
      workspaceRoot: root,
      files: [
        { relativePath: "AGENTS.md", content: "new-agents\n" },
        { relativePath: ".trellis/spec/ok.md", content: "new-spec\n" },
      ],
      policyHooks: {
        afterWritePublish: async () => {
          publishes += 1;
          if (publishes === 2) {
            throw new Error("injected second publish failure");
          }
        },
      },
    });
    expect(result.written).toEqual([]);
    expect(result.status).toBe("rolled_back");
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("keep-agents\n");
    expect(await readFile(path.join(root, ".trellis", "spec", "ok.md"), "utf8")).toBe("keep-spec\n");
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
