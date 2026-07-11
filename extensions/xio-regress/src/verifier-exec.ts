import { createHash, randomUUID } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { spawnCommand } from "../../xio-eval/src/process.ts";
import { git, gitOk } from "../../xio-sandbox/src/git.ts";
import { WorktreeSandbox } from "../../xio-sandbox/src/worktree-sandbox.ts";

import type { PrivateRegressionCase } from "./types.ts";
import type { SpawnResult } from "../../xio-eval/src/process.ts";
import type { WorktreeSession } from "../../xio-sandbox/src/worktree-sandbox.ts";

export type SourceSnapshot = Readonly<{ head: string; status: string }>;

export async function runVerifier(
  regression: PrivateRegressionCase,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  const shell = process.platform === "win32" ? "cmd.exe" : (env.SHELL ?? "/bin/sh");
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", regression.verifier.command]
    : ["-lc", regression.verifier.command];
  return spawnCommand({
    command: shell,
    args,
    cwd,
    env,
    timeoutMs: regression.verifier.timeout_ms,
    maxOutputBytes: 64 * 1024,
  });
}

export function verifierInfraErrors(outcome: SpawnResult): string[] {
  const errors: string[] = [];
  if (outcome.timedOut) errors.push("verifier timed out");
  if (outcome.cleanupError) errors.push(outcome.cleanupError);
  if (outcome.signal) errors.push(`verifier exited by signal ${outcome.signal}`);
  if (outcome.code === null) errors.push("verifier did not return an exit code");
  if (outcome.code === 126 || outcome.code === 127) errors.push("verifier command could not be executed");
  if (outcome.code !== null && outcome.code >= 128) errors.push("verifier process crashed");
  return errors;
}

export async function sourceSnapshot(repoRoot: string): Promise<SourceSnapshot> {
  const [head, status] = await Promise.all([
    gitOk(repoRoot, ["rev-parse", "HEAD"]),
    gitOk(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  return { head, status };
}

export async function sourceUnchanged(repoRoot: string, before: SourceSnapshot): Promise<boolean> {
  const after = await sourceSnapshot(repoRoot).catch(() => null);
  return after !== null && snapshotsEqual(before, after);
}

export function snapshotsEqual(left: SourceSnapshot, right: SourceSnapshot): boolean {
  return left.head === right.head && left.status === right.status;
}

export async function assertBaseCommit(regression: PrivateRegressionCase): Promise<void> {
  const result = await git(regression.source.repo_root, [
    "cat-file",
    "-e",
    `${regression.source.base_commit}^{commit}`,
  ]);
  if (result.code !== 0) {
    throw new Error(`base commit is unavailable: ${regression.source.base_commit}`);
  }
}

export function statusHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createPinnedBaseWorktree(
  regression: PrivateRegressionCase,
  storeRoot: string,
): Promise<WorktreeSession> {
  return WorktreeSandbox.create({
    mainRoot: regression.source.repo_root,
    baseDir: path.join(storeRoot, ".worktrees"),
    baseRef: regression.source.base_commit,
    sessionId: `regress-${randomUUID().slice(0, 12)}`,
  });
}

export async function cleanupWorktree(session: WorktreeSession): Promise<Readonly<{
  temporaryWorktree: string | null;
  errors: readonly string[];
}>> {
  try {
    await WorktreeSandbox.remove(session, { force: true });
    return { temporaryWorktree: null, errors: [] };
  } catch (error) {
    return {
      temporaryWorktree: session.worktreePath,
      errors: [`worktree cleanup failed: ${errorMessage(error)}`],
    };
  }
}

export async function resolveExistingDirectory(value: string): Promise<string> {
  try {
    await access(value);
    const resolved = await realpath(value);
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new Error(`path is not a directory: ${value}`);
    }
    return resolved;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("path is not a directory")) {
      throw error;
    }
    throw new Error(`path is unavailable: ${value}`, { cause: error });
  }
}
