import { runSupervisedProcessGated } from "../../../src/runtime/process/index.ts";

export type GitResult = Readonly<{
  stdout: string;
  stderr: string;
  code: number;
}>;

/** Callers parse git output, so it must arrive whole: past this, fail instead of truncating. */
const GIT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
/** Plumbing is local and non-interactive; this only bounds a hung git. */
const GIT_TIMEOUT_MS = 10 * 60_000;

/**
 * Subcommands that never write the work tree, index or refs. They run without
 * the workspace write lease; everything else queues behind writers.
 */
const READ_ONLY_SUBCOMMANDS = new Set([
  "cat-file",
  "diff",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "rev-list",
  "rev-parse",
  "show",
  "show-ref",
  "status",
]);

export async function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  return runGit(cwd, args);
}

export async function gitWithEnv(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<GitResult> {
  return runGit(cwd, args, env);
}

async function runGit(
  cwd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<GitResult> {
  const result = await runSupervisedProcessGated({
    command: "git",
    args,
    cwd,
    // Same environment git always had here (it needs HOME, PATH, GIT_*), plus overrides.
    env: env ? { ...process.env, ...env } : { ...process.env },
    timeoutMs: GIT_TIMEOUT_MS,
    access: READ_ONLY_SUBCOMMANDS.has(args[0] ?? "") ? "read" : "write",
    output: {
      headBytes: GIT_OUTPUT_LIMIT_BYTES,
      tailBytes: 0,
      hardCapBytes: GIT_OUTPUT_LIMIT_BYTES * 2,
    },
  });
  if (result.stdoutTruncated || result.stderrTruncated) {
    return {
      stdout: "",
      stderr: `git ${args.join(" ")}: output exceeded ${GIT_OUTPUT_LIMIT_BYTES} bytes`,
      code: 1,
    };
  }
  if (result.termination !== "exited") {
    return {
      stdout: result.stdout.trimEnd(),
      stderr: (result.stderr || result.cleanupError || `git ${args.join(" ")}: ${result.termination}`).trimEnd(),
      code: 1,
    };
  }
  return {
    stdout: result.stdout.trimEnd(),
    stderr: result.stderr.trimEnd(),
    code: result.code ?? 1,
  };
}

export async function gitOk(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout || `git ${args.join(" ")} failed`;
    throw new Error(detail);
  }
  return result.stdout;
}

export async function gitWithEnvOk(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<string> {
  const result = await gitWithEnv(cwd, args, env);
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout || `git ${args.join(" ")} failed`;
    throw new Error(detail);
  }
  return result.stdout;
}
