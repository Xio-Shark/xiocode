import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WorkspacePathError,
  WorkspacePathPolicy,
  type CheckedWorkspacePath,
} from "./workspace-path-policy.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{ base: string; root: string; outside: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "xio-path-policy-"));
  tempDirs.push(base);
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { base, root, outside };
}

function expectPathCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof WorkspacePathError && error.code === code;
}

describe("WorkspacePathPolicy authorization", () => {
  it("accepts a symlinked workspace root alias but rejects every link below it", async () => {
    const { base, root, outside } = await fixture();
    const alias = path.join(base, "workspace-alias");
    await symlink(root, alias, "dir");
    await writeFile(path.join(root, "ok.txt"), "ok\n", "utf8");
    await writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");
    await symlink(path.join(root, "ok.txt"), path.join(root, "inside-link.txt"));
    await symlink(path.join(outside, "secret.txt"), path.join(root, "outside-link.txt"));
    await symlink(path.join(root, "missing.txt"), path.join(root, "broken-link.txt"));

    const policy = await WorkspacePathPolicy.create({ workspaceRoot: alias, cwd: alias });
    expect((await policy.readFile("ok.txt")).toString("utf8")).toBe("ok\n");

    for (const name of ["inside-link.txt", "outside-link.txt", "broken-link.txt"]) {
      await expect(policy.readFile(name)).rejects.toSatisfy(expectPathCode("SYMLINK_COMPONENT"));
    }
  });

  it("uses component containment, permits ..foo, and resolves nested missing targets", async () => {
    const { root } = await fixture();
    await mkdir(path.join(root, "..foo"));
    await writeFile(path.join(root, "..foo", "ok.txt"), "ok\n", "utf8");
    const policy = await WorkspacePathPolicy.create({ workspaceRoot: root });

    expect((await policy.readFile("..foo/ok.txt")).toString("utf8")).toBe("ok\n");
    const missing = await policy.resolve("write-file", "deep/missing/file.txt");
    expect(missing.kind).toBe("missing");
    expect(missing.canonicalPath).toBe(path.join(policy.workspaceRoot, "deep", "missing", "file.txt"));
    expect(missing.canonicalParent).toBe(path.join(policy.workspaceRoot, "deep", "missing"));
    await expect(policy.readFile("../outside.txt")).rejects.toSatisfy(
      expectPathCode("OUTSIDE_WORKSPACE"),
    );
  });

  it("rejects a symlinked ancestor before reading or writing an outside canary", async () => {
    const { root, outside } = await fixture();
    const canary = path.join(outside, "canary.txt");
    await writeFile(canary, "outside\n", "utf8");
    await symlink(outside, path.join(root, "linked-dir"), "dir");
    const policy = await WorkspacePathPolicy.create({ workspaceRoot: root });

    await expect(policy.readFile("linked-dir/canary.txt")).rejects.toSatisfy(
      expectPathCode("SYMLINK_COMPONENT"),
    );
    await expect(policy.writeFileAtomic("linked-dir/canary.txt", "changed\n")).rejects.toSatisfy(
      expectPathCode("SYMLINK_COMPONENT"),
    );
    expect(await readFile(canary, "utf8")).toBe("outside\n");
  });

  it("grants an exact outside read/search request once and never grants writes", async () => {
    const { root, outside } = await fixture();
    const externalFile = path.join(outside, "external.txt");
    await writeFile(externalFile, "external\n", "utf8");
    const policy = await WorkspacePathPolicy.create({ workspaceRoot: root });

    const decision = await policy.inspect("read-file", externalFile);
    expect(decision.decision).toBe("external");
    if (decision.decision !== "external") throw new Error("expected external request");
    policy.grantOnce("call-1", decision.request);
    expect((await policy.readFile(externalFile, "call-1")).toString("utf8")).toBe("external\n");
    await expect(policy.readFile(externalFile, "call-1")).rejects.toSatisfy(
      expectPathCode("OUTSIDE_WORKSPACE"),
    );
    await expect(policy.resolve("write-file", externalFile, "call-2")).rejects.toSatisfy(
      expectPathCode("OUTSIDE_WORKSPACE"),
    );
  });
});

describe("WorkspacePathPolicy safe reads and atomic writes", () => {
  it("fails closed when the target identity changes before read bytes are returned", async () => {
    const { root, outside } = await fixture();
    const target = path.join(root, "target.txt");
    const canary = path.join(outside, "canary.txt");
    await writeFile(target, "inside\n", "utf8");
    await writeFile(canary, "outside\n", "utf8");
    let swapped = false;
    const policy = await WorkspacePathPolicy.create({
      workspaceRoot: root,
      hooks: {
        beforeReadOpen: async (_checked: CheckedWorkspacePath) => {
          if (swapped) return;
          swapped = true;
          await rm(target);
          await symlink(canary, target);
        },
      },
    });

    await expect(policy.readFile("target.txt")).rejects.toSatisfy((error: unknown) =>
      error instanceof WorkspacePathError
      && (error.code === "PATH_CHANGED" || error.code === "SYMLINK_COMPONENT"));
  });

  it("atomically replaces a regular file, preserves executable mode, and leaves no staging file", async () => {
    const { root } = await fixture();
    const target = path.join(root, "script.sh");
    await writeFile(target, "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(target, 0o755);
    const policy = await WorkspacePathPolicy.create({ workspaceRoot: root });

    await policy.writeFileAtomic("script.sh", "#!/bin/sh\nexit 0\n");

    expect(await readFile(target, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect((await lstat(target)).mode & 0o777).toBe(0o755);
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("keeps the original file and cleans staging when publish validation fails", async () => {
    const { root } = await fixture();
    const target = path.join(root, "target.txt");
    await writeFile(target, "old\n", "utf8");
    const policy = await WorkspacePathPolicy.create({
      workspaceRoot: root,
      hooks: {
        beforeWritePublish: async () => {
          throw new Error("injected publish failure");
        },
      },
    });

    await expect(policy.writeFileAtomic("target.txt", "new\n")).rejects.toThrow(
      "injected publish failure",
    );
    expect(await readFile(target, "utf8")).toBe("old\n");
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("restores prior bytes when post-rename validation fails", async () => {
    const { root } = await fixture();
    const target = path.join(root, "target.txt");
    await writeFile(target, "old\n", "utf8");
    const policy = await WorkspacePathPolicy.create({
      workspaceRoot: root,
      hooks: {
        afterWritePublish: async () => {
          throw new Error("injected post-publish failure");
        },
      },
    });

    await expect(policy.writeFileAtomic("target.txt", "new\n")).rejects.toThrow(
      "injected post-publish failure",
    );
    expect(await readFile(target, "utf8")).toBe("old\n");
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
