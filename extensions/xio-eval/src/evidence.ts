import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";

import { git, gitOk } from "../../xio-sandbox/src/git.ts";

import type { CandidateResult } from "./types.ts";

export type RunEvidence = Readonly<{
  trajectoryPath: string | null;
  secretRedactionOk: boolean;
  complete: boolean;
}>;

export async function candidateRevision(candidateRoot: string): Promise<string> {
  const head = await gitOk(candidateRoot, ["rev-parse", "HEAD"]);
  const [diff, status, untracked] = await Promise.all([
    gitOk(candidateRoot, ["-c", "core.quotePath=false", "diff", "--binary", "HEAD"]),
    gitOk(candidateRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    gitOk(candidateRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const hash = createHash("sha256").update(head).update(diff).update(status);
  for (const relativePath of untracked.split("\0").filter(Boolean).sort()) {
    const entryPath = path.join(candidateRoot, relativePath);
    const entry = await lstat(entryPath);
    hash.update(relativePath).update("\0");
    if (entry.isDirectory()) {
      hash.update("directory\0");
    } else if (entry.isSymbolicLink()) {
      hash.update("symlink\0").update(await readlink(entryPath)).update("\0");
    } else if (entry.isFile()) {
      hash.update("file\0").update(await readFile(entryPath));
    } else {
      throw new Error(`unsupported untracked entry type: ${relativePath}`);
    }
  }
  return `${head.slice(0, 12)}-${hash.digest("hex").slice(0, 12)}`;
}

export async function worktreePatchSummary(worktreePath: string | undefined): Promise<string> {
  if (!worktreePath) {
    return "(candidate worktree unavailable)";
  }
  const [status, diff] = await Promise.all([
    git(worktreePath, ["status", "--short"]),
    git(worktreePath, ["diff", "--stat"]),
  ]);
  return [status.stdout, diff.stdout].filter((part) => part.trim().length > 0).join("\n") || "(no changes)";
}

export async function collectRunEvidence(trialRoot: string, candidate: CandidateResult): Promise<RunEvidence> {
  if (!candidate.run_id) {
    return { trajectoryPath: null, secretRedactionOk: false, complete: false };
  }
  const runRoot = path.join(trialRoot, "home", ".xiocode", "runs", candidate.run_id);
  const trajectoryPath = path.join(runRoot, "trajectory.json");
  const eventsPath = path.join(runRoot, "events.jsonl");
  const [events, trajectory] = await Promise.all([
    readFile(eventsPath, "utf8").catch(() => undefined),
    readFile(trajectoryPath, "utf8").catch(() => undefined),
  ]);
  const complete = events !== undefined && trajectory !== undefined;
  return {
    trajectoryPath: trajectory === undefined ? null : trajectoryPath,
    secretRedactionOk: complete && !containsKnownSecret(`${events}\n${trajectory}`),
    complete,
  };
}

function containsKnownSecret(value: string): boolean {
  return /sk-[A-Za-z0-9]{48}|ghp_[A-Za-z0-9]{32,}|sk-ant-[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}/.test(value);
}
