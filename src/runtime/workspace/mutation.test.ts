import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WorkspaceMutationError,
  WorkspaceMutationService,
} from "./mutation.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(prefix = "xio-workspace-mutation-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("WorkspaceMutationService", () => {
  it("stages and commits the whole batch with existing-file checkpoints", async () => {
    const root = await fixture();
    await mkdir(path.join(root, ".trellis", "spec"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "old agents\n", "utf8");
    const service = new WorkspaceMutationService({
      workspaceRoot: root,
      now: () => 99,
      randomId: () => "tx",
    });

    const receipt = await service.writeBatch([
      { relativePath: "AGENTS.md", content: "new agents\n" },
      { relativePath: ".trellis/spec/runtime.md", content: "runtime rule\n" },
    ]);

    expect(receipt).toMatchObject({
      schema_version: "xio-workspace-mutation.v1",
      transaction_id: "wm-99-tx",
      status: "committed",
      phase: "committed",
    });
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("new agents\n");
    expect(await readFile(path.join(root, "AGENTS.md.bak-99"), "utf8")).toBe("old agents\n");
    expect(await readFile(path.join(root, ".trellis", "spec", "runtime.md"), "utf8"))
      .toBe("runtime rule\n");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked parent that resolves outside the workspace before mutation",
    async () => {
      const root = await fixture();
      const outside = await fixture("xio-workspace-mutation-outside-");
      await mkdir(path.join(root, ".trellis"), { recursive: true });
      await symlink(outside, path.join(root, ".trellis", "spec"), "dir");
      const service = new WorkspaceMutationService({ workspaceRoot: root });

      const pending = service.writeBatch([
        { relativePath: ".trellis/spec/escaped.md", content: "must not escape\n" },
      ]);

      await expect(pending).rejects.toMatchObject({
        name: "WorkspaceMutationError",
        receipt: { status: "rejected", phase: "validate" },
      });
      await expect(readFile(path.join(outside, "escaped.md"), "utf8")).rejects.toThrow();
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "publishes through an internal symlink using the canonical target",
    async () => {
      const root = await fixture();
      const actualSpec = path.join(root, "actual-spec");
      await mkdir(path.join(root, ".trellis"), { recursive: true });
      await mkdir(actualSpec, { recursive: true });
      await symlink(actualSpec, path.join(root, ".trellis", "spec"), "dir");
      const service = new WorkspaceMutationService({ workspaceRoot: root });

      const receipt = await service.writeBatch([
        { relativePath: ".trellis/spec/rule.md", content: "inside\n" },
      ]);

      expect(receipt.status).toBe("committed");
      expect(receipt.files[0]?.target_path).toBe(path.join(await realpath(actualSpec), "rule.md"));
      expect(await readFile(path.join(root, ".trellis", "spec", "rule.md"), "utf8"))
        .toBe("inside\n");
      expect((await lstat(path.join(root, ".trellis", "spec"))).isSymbolicLink()).toBe(true);
    },
  );

  it("rolls back every target when the second publish fails", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "AGENTS.md"), "agents before\n", "utf8");
    await writeFile(path.join(root, "CLAUDE.md"), "claude before\n", "utf8");
    const service = new WorkspaceMutationService({
      workspaceRoot: root,
      now: () => 123,
      randomId: () => "rollback",
      hooks: {
        beforePublish({ index }) {
          if (index === 1) throw new Error("injected second publish failure");
        },
      },
    });

    let failure: WorkspaceMutationError | undefined;
    try {
      await service.writeBatch([
        { relativePath: "AGENTS.md", content: "agents after\n" },
        { relativePath: "CLAUDE.md", content: "claude after\n" },
      ]);
    } catch (error) {
      if (error instanceof WorkspaceMutationError) failure = error;
      else throw error;
    }

    expect(failure?.receipt).toMatchObject({
      status: "rolled_back",
      phase: "publish",
      error: "injected second publish failure",
    });
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("agents before\n");
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe("claude before\n");
    expect((await readdir(root)).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("removes staged files and newly created directories after rollback", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "AGENTS.md"), "before\n", "utf8");
    const service = new WorkspaceMutationService({
      workspaceRoot: root,
      hooks: {
        beforePublish({ index }) {
          if (index === 1) throw new Error("stop before nested publish");
        },
      },
    });

    await expect(service.writeBatch([
      { relativePath: "AGENTS.md", content: "after\n" },
      { relativePath: "new/nested/rule.md", content: "new\n" },
    ])).rejects.toMatchObject({
      receipt: { status: "rolled_back", phase: "publish" },
    });
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("before\n");
    expect(await readdir(root)).toEqual(["AGENTS.md"]);
  });

  it.skipIf(process.platform === "win32")(
    "rejects duplicate canonical targets before creating backups",
    async () => {
      const root = await fixture();
      await mkdir(path.join(root, ".trellis", "spec"), { recursive: true });
      const target = path.join(root, ".trellis", "spec", "real.md");
      await writeFile(target, "before\n", "utf8");
      await symlink(target, path.join(root, ".trellis", "spec", "alias.md"));
      const service = new WorkspaceMutationService({ workspaceRoot: root, now: () => 5 });

      await expect(service.writeBatch([
        { relativePath: ".trellis/spec/real.md", content: "one\n" },
        { relativePath: ".trellis/spec/alias.md", content: "two\n" },
      ])).rejects.toMatchObject({
        receipt: { status: "rejected", phase: "validate" },
      });
      expect(await readFile(target, "utf8")).toBe("before\n");
      await expect(readFile(`${target}.bak-5`, "utf8")).rejects.toThrow();
    },
  );

  it("rejects backup collisions before staging or changing the target", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "AGENTS.md"), "before\n", "utf8");
    await writeFile(path.join(root, "AGENTS.md.bak-7"), "existing backup\n", "utf8");
    const service = new WorkspaceMutationService({ workspaceRoot: root, now: () => 7 });

    await expect(service.writeBatch([
      { relativePath: "AGENTS.md", content: "after\n" },
    ])).rejects.toMatchObject({
      receipt: { status: "rejected", phase: "validate" },
    });
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("before\n");
    expect((await readdir(root)).sort()).toEqual(["AGENTS.md", "AGENTS.md.bak-7"]);
  });
});
