import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  RegressionCapture,
  RegressionCaseStore,
  RegressionPreflight,
} from "../src/index.ts";

const execFileAsync = promisify(execFile);

export type RegressionFixture = Readonly<{
  root: string;
  repo: string;
  base: string;
  runRoot: string;
  promptSha: string;
  store: RegressionCaseStore;
  capture: RegressionCapture;
  preflight: RegressionPreflight;
}>;

export async function createFixture(
  temporaryRoots: string[],
  status: "success" | "failed",
  withProvenance = true,
  env: NodeJS.ProcessEnv = { SHELL: "/bin/sh" },
): Promise<RegressionFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-regress-"));
  temporaryRoots.push(root);
  const repo = path.join(root, "repo");
  const runRoot = path.join(root, "runs");
  const regressionRoot = path.join(root, "regressions");
  await mkdir(repo, { recursive: true });
  await initRepo(repo);
  const base = await git(repo, ["rev-parse", "HEAD"]);
  const promptSha = sha256("repair the private failure");
  await writeRun(runRoot, { repo, base, promptSha, status, withProvenance });
  const store = new RegressionCaseStore(regressionRoot);
  return {
    root,
    repo,
    base,
    runRoot,
    promptSha,
    store,
    capture: new RegressionCapture({
      run_root: runRoot,
      store,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    }),
    preflight: new RegressionPreflight({ store, env }),
  };
}

export function captureInput(repo: string, base: string, command: string) {
  return {
    run_id: "run-1",
    repo_root: repo,
    base_commit: base,
    failure_type: "user_task_failure",
    failure_statement: "the requested behavior is missing",
    verifier_command: command,
  };
}

export async function gitState(repo: string): Promise<readonly string[]> {
  return Promise.all([
    git(repo, ["rev-parse", "HEAD"]),
    git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd, encoding: "utf8" });
  return result.stdout.trimEnd();
}

async function writeRun(
  runRoot: string,
  options: Readonly<{
    repo: string;
    base: string;
    promptSha: string;
    status: "success" | "failed";
    withProvenance: boolean;
  }>,
): Promise<void> {
  const run = path.join(runRoot, "run-1");
  await mkdir(run, { recursive: true });
  await writeJson(path.join(run, "metadata.json"), {
    run_id: "run-1",
    provider: "stub",
    model: "model",
    started_at: "2026-07-11T00:00:00.000Z",
  });
  await writeJson(path.join(run, "summary.json"), {
    run_id: "run-1",
    status: options.status,
    success: options.status === "success",
  });
  await writeJson(path.join(run, "trajectory.json"), {
    messages: options.withProvenance
      ? []
      : [{ role: "user", content: "repair the private failure" }],
    tool_rounds: [],
  });
  if (options.withProvenance) {
    await writeJson(path.join(run, "prompt.json"), {
      schema_version: "xio-run-prompt.v2",
      content: "repair the private failure",
      prompt_sha: options.promptSha,
    });
    await writeJson(path.join(run, "provenance.json"), {
      schema_version: "xio-run-provenance.v1",
      workspace_root: options.repo,
      main_root: options.repo,
      base_commit: options.base,
      branch: "main",
      dirty: false,
      dirty_summary_sha: sha256(""),
      xiocode_revision: "test",
      created_at: "2026-07-11T00:00:00.000Z",
    });
  }
}

export async function initRepo(repo: string, content = "base\n"): Promise<void> {
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "xio@test"]);
  await git(repo, ["config", "user.name", "xio"]);
  await writeFile(path.join(repo, "README.md"), content, "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "init"]);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
