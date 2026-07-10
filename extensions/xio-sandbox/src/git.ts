import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitResult = Readonly<{
  stdout: string;
  stderr: string;
  code: number;
}>;

export async function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code: 0 };
  } catch (error) {
    const err = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const code = typeof err.code === "number" ? err.code : 1;
    return {
      stdout: typeof err.stdout === "string" ? err.stdout.trimEnd() : "",
      stderr: typeof err.stderr === "string" ? err.stderr.trimEnd() : (err.message ?? String(error)),
      code,
    };
  }
}

export async function gitOk(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout || `git ${args.join(" ")} failed`;
    throw new Error(detail);
  }
  return result.stdout;
}
