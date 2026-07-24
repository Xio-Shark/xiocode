import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { candidateRevision } from "../src/evidence.ts";
import { gitOk } from "../../xio-sandbox/src/git.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("candidate revision evidence", () => {
  it("hashes non-ASCII untracked filenames independently of core.quotePath", async () => {
    const root = await initializedRepository();
    const untrackedPath = path.join(root, "未跟踪文件.md");
    await writeFile(untrackedPath, "first\n", "utf8");

    await gitOk(root, ["config", "core.quotePath", "true"]);
    const quotedRevision = await candidateRevision(root);
    await gitOk(root, ["config", "core.quotePath", "false"]);
    expect(await candidateRevision(root)).toBe(quotedRevision);

    await writeFile(untrackedPath, "second\n", "utf8");
    expect(await candidateRevision(root)).not.toBe(quotedRevision);
  });

  it("hashes nested repositories as deterministic directory entries", async () => {
    const root = await initializedRepository();
    await initializeRepository(path.join(root, ".scratch", "reference-one"));

    const revision = await candidateRevision(root);
    expect(revision).toMatch(/^[a-f0-9]{12}-[a-f0-9]{12}$/);
    expect(await candidateRevision(root)).toBe(revision);

    await initializeRepository(path.join(root, ".scratch", "reference-two"));
    expect(await candidateRevision(root)).not.toBe(revision);
  });
});

async function initializedRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-eval-evidence-"));
  tempDirs.push(root);
  await initializeRepository(root);
  return root;
}

async function initializeRepository(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await gitOk(root, ["init", "-q"]);
  await writeFile(path.join(root, "tracked.txt"), "tracked\n", "utf8");
  await gitOk(root, ["add", "tracked.txt"]);
  await gitOk(root, [
    "-c",
    "user.name=Xio Eval",
    "-c",
    "user.email=xio-eval@example.invalid",
    "commit",
    "-qm",
    "initial",
  ]);
}
