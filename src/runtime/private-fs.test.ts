import { mkdtemp, readFile, rm, symlink, writeFile, chmod, mkdir, stat, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  PrivateFsError,
  appendPrivateFile,
  ensurePrivateDir,
  ensurePrivateFile,
  migrateSensitiveLocalState,
  tightenOwnedTree,
  writePrivateFile,
  writePrivateFileAtomic,
} from "./private-fs.ts";

const tempDirs: string[] = [];
const isPosix = process.platform !== "win32";

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-private-fs-"));
  tempDirs.push(root);
  return root;
}

async function modeOf(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777;
}

describe.skipIf(!isPosix)("private-fs posix modes", () => {
  it.each([0o000, 0o022, 0o077] as const)(
    "ensurePrivateDir/File honor umask %#",
    async (mask) => {
      const previous = process.umask(mask);
      try {
        const root = await tempRoot();
        const dir = path.join(root, "state");
        const file = path.join(dir, "secret.json");
        await ensurePrivateDir(dir);
        await writePrivateFile(file, "secret\n");
        expect(await modeOf(dir)).toBe(PRIVATE_DIR_MODE);
        expect(await modeOf(file)).toBe(PRIVATE_FILE_MODE);
        expect(await readFile(file, "utf8")).toBe("secret\n");
      } finally {
        process.umask(previous);
      }
    },
  );

  it("tightens existing wide permissions without rewriting content", async () => {
    const root = await tempRoot();
    const dir = path.join(root, "sessions");
    const file = path.join(dir, "state.json");
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await writeFile(file, "payload-v1\n", { mode: 0o644 });
    await chmod(dir, 0o755);
    await chmod(file, 0o644);

    await tightenOwnedTree(dir);
    expect(await modeOf(dir)).toBe(PRIVATE_DIR_MODE);
    expect(await modeOf(file)).toBe(PRIVATE_FILE_MODE);
    expect(await readFile(file, "utf8")).toBe("payload-v1\n");
  });

  it("rejects symlink roots and does not follow them", async () => {
    const root = await tempRoot();
    const real = path.join(root, "real");
    const link = path.join(root, "link");
    await mkdir(real, { recursive: true });
    await writeFile(path.join(real, "x.txt"), "keep\n", { mode: 0o644 });
    await chmod(real, 0o755);
    await symlink(real, link);

    await expect(ensurePrivateDir(link)).rejects.toBeInstanceOf(PrivateFsError);
    await expect(tightenOwnedTree(link)).rejects.toBeInstanceOf(PrivateFsError);
    expect(await modeOf(real)).toBe(0o755);
    expect(await readFile(path.join(real, "x.txt"), "utf8")).toBe("keep\n");
  });

  it("rejects symlink files during ensurePrivateFile / write", async () => {
    const root = await tempRoot();
    const real = path.join(root, "real.txt");
    const link = path.join(root, "link.txt");
    await writeFile(real, "target\n", { mode: 0o644 });
    await symlink(real, link);

    await expect(ensurePrivateFile(link)).rejects.toBeInstanceOf(PrivateFsError);
    await expect(writePrivateFile(link, "nope\n")).rejects.toBeInstanceOf(PrivateFsError);
    expect(await readFile(real, "utf8")).toBe("target\n");
    expect(await modeOf(real)).toBe(0o644);
  });

  it("writePrivateFileAtomic replaces wide files with 0600 and keeps parent 0700", async () => {
    const root = await tempRoot();
    const file = path.join(root, "runtime-config.json");
    await writeFile(file, "old\n", { mode: 0o644 });
    await writePrivateFileAtomic(file, "new\n");
    expect(await readFile(file, "utf8")).toBe("new\n");
    expect(await modeOf(file)).toBe(PRIVATE_FILE_MODE);
    expect(await modeOf(root)).toBe(PRIVATE_DIR_MODE);
  });

  it("appendPrivateFile creates 0600 journals", async () => {
    const root = await tempRoot();
    const file = path.join(root, "journal.jsonl");
    await appendPrivateFile(file, '{"seq":1}\n');
    await appendPrivateFile(file, '{"seq":2}\n');
    expect(await readFile(file, "utf8")).toBe('{"seq":1}\n{"seq":2}\n');
    expect(await modeOf(file)).toBe(PRIVATE_FILE_MODE);
  });

  it("allows creating under a host ancestor symlink without following the leaf", async () => {
    const root = await tempRoot();
    const realHost = path.join(root, "real-host");
    const hostLink = path.join(root, "host-link");
    await mkdir(realHost, { recursive: true });
    await symlink(realHost, hostLink);

    const managed = path.join(hostLink, "xiocode-state");
    await ensurePrivateDir(managed);
    expect(await modeOf(managed)).toBe(PRIVATE_DIR_MODE);
    expect((await lstat(managed)).isSymbolicLink()).toBe(false);

    // Leaf remaining a symlink is still rejected.
    const leafLink = path.join(root, "leaf-link");
    await symlink(managed, leafLink);
    await expect(ensurePrivateDir(leafLink)).rejects.toBeInstanceOf(PrivateFsError);
  });

  it("migrateSensitiveLocalState tightens home trees but not worktree file modes", async () => {
    const home = await tempRoot();
    const sessions = path.join(home, "sessions", "abc");
    const runs = path.join(home, "runs", "run-1");
    const worktree = path.join(home, "worktrees", "repo", "sess");
    const script = path.join(worktree, "tool.sh");
    const linked = path.join(worktree, "linked.txt");
    const linkInCheckout = path.join(worktree, "link.txt");
    await mkdir(sessions, { recursive: true, mode: 0o755 });
    await mkdir(runs, { recursive: true, mode: 0o755 });
    await mkdir(worktree, { recursive: true, mode: 0o755 });
    await writeFile(path.join(sessions, "state.json"), "s\n", { mode: 0o644 });
    await writeFile(path.join(runs, "trajectory.json"), "t\n", { mode: 0o644 });
    await writeFile(script, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(linked, "keep\n", { mode: 0o644 });
    await symlink(linked, linkInCheckout);
    await writeFile(path.join(home, "credentials.json"), "{}\n", { mode: 0o644 });

    await migrateSensitiveLocalState({
      xioHome: home,
      credentialsPath: path.join(home, "credentials.json"),
      sessionsRoot: path.join(home, "sessions"),
      runRoot: path.join(home, "runs"),
      worktreesRoot: path.join(home, "worktrees"),
    });

    expect(await modeOf(home)).toBe(PRIVATE_DIR_MODE);
    expect(await modeOf(sessions)).toBe(PRIVATE_DIR_MODE);
    expect(await modeOf(path.join(sessions, "state.json"))).toBe(PRIVATE_FILE_MODE);
    expect(await modeOf(path.join(runs, "trajectory.json"))).toBe(PRIVATE_FILE_MODE);
    expect(await modeOf(path.join(home, "credentials.json"))).toBe(PRIVATE_FILE_MODE);
    expect(await modeOf(path.join(home, "worktrees"))).toBe(PRIVATE_DIR_MODE);
    expect(await modeOf(worktree)).toBe(PRIVATE_DIR_MODE);
    expect(await modeOf(script)).toBe(0o755);
    expect(await modeOf(linked)).toBe(0o644);
    expect((await lstat(linkInCheckout)).isSymbolicLink()).toBe(true);
    expect((await lstat(script)).isFile()).toBe(true);
  });
});

describe("private-fs symlink rejection (all platforms)", () => {
  it("surfaces operation and path on symlink errors", async () => {
    const root = await tempRoot();
    const real = path.join(root, "real");
    const link = path.join(root, "link");
    await mkdir(real);
    await symlink(real, link);
    try {
      await ensurePrivateDir(link);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PrivateFsError);
      const err = error as PrivateFsError;
      expect(err.operation).toBe("ensurePrivateDir");
      expect(err.path).toBe(path.resolve(link));
      expect(err.message).toContain("symbolic link");
    }
  });
});
