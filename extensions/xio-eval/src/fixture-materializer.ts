import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { gitOk } from "../../xio-sandbox/src/git.ts";

import type { LoadedFixture } from "./types.ts";

export type RepoSnapshot = Readonly<{
  head: string;
  status: string;
}>;

export async function materializeFixture(fixture: LoadedFixture, parent: string): Promise<string> {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, `${fixture.id}-`));
  await writeFiles(root, fixture.public_files);
  await gitOk(root, ["init"]);
  await gitOk(root, ["config", "user.email", "xio-eval@local"]);
  await gitOk(root, ["config", "user.name", "Xio Eval"]);
  await gitOk(root, ["add", "-A"]);
  await gitOk(root, ["commit", "-m", `fixture ${fixture.id}`]);
  return root;
}

export async function applyOracle(root: string, fixture: LoadedFixture): Promise<void> {
  await writeFiles(root, fixture.oracle_files);
}

export async function snapshotRepo(root: string): Promise<RepoSnapshot> {
  const [head, status] = await Promise.all([
    gitOk(root, ["rev-parse", "HEAD"]),
    gitOk(root, ["status", "--porcelain"]),
  ]);
  return { head, status };
}

export async function patchSummary(root: string): Promise<string> {
  const status = await gitOk(root, ["status", "--short"]);
  const diff = await gitOk(root, ["diff", "--stat"]);
  return [status, diff].filter((part) => part.trim().length > 0).join("\n") || "(no changes)";
}

export async function validateCandidateWorktree(options: Readonly<{
  fixtureRoot: string;
  allowedRoot: string;
  reportedPath?: string;
}>): Promise<string> {
  if (!options.reportedPath) {
    throw new Error("candidate did not report a worktree");
  }
  const [fixtureRoot, allowedRoot, reportedPath] = await Promise.all([
    realpath(options.fixtureRoot),
    realpath(options.allowedRoot),
    realpath(options.reportedPath),
  ]);
  if (!isInside(allowedRoot, reportedPath)) {
    throw new Error(`candidate worktree is outside the isolated trial root: ${reportedPath}`);
  }
  const listing = await gitOk(fixtureRoot, ["worktree", "list", "--porcelain"]);
  const registered = listing.split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));
  if (!registered.includes(reportedPath)) {
    throw new Error("candidate worktree is not registered to the fixture repository");
  }
  const commonDir = path.resolve(reportedPath, await gitOk(reportedPath, [
    "rev-parse", "--path-format=absolute", "--git-common-dir",
  ]));
  if (await realpath(commonDir) !== await realpath(path.join(fixtureRoot, ".git"))) {
    throw new Error("candidate worktree does not share the fixture git directory");
  }
  return reportedPath;
}

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = safeTarget(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

function safeTarget(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(prefix)) {
    throw new Error(`fixture path escapes root: ${relativePath}`);
  }
  return target;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
