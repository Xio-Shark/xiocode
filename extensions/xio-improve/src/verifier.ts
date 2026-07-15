import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { VerifierResult } from "./types.ts";

const execFileAsync = promisify(execFile);

export type VerifierOptions = Readonly<{
  cwd: string;
  /**
   * Extra shell commands after the default `npm run check`.
   * When `replaceDefault` is true, this is the full command list (tests / explicit).
   */
  commands?: readonly string[];
  /**
   * When true, `commands` fully replaces the default instead of appending.
   * Production CLI always leaves this false so `npm run check` cannot be dropped.
   */
  replaceDefault?: boolean;
}>;

const DEFAULT_COMMANDS = ["npm run check"] as const;

/**
 * Runs verifier commands inside the worktree cwd.
 * Default is always `npm run check`; callers may append extras via `commands`.
 */
export class Verifier {
  readonly #cwd: string;
  readonly #commands: readonly string[];

  constructor(options: VerifierOptions) {
    this.#cwd = options.cwd;
    if (options.replaceDefault === true) {
      this.#commands = options.commands && options.commands.length > 0
        ? [...options.commands]
        : [...DEFAULT_COMMANDS];
    } else {
      this.#commands = [...DEFAULT_COMMANDS, ...(options.commands ?? [])];
    }
  }

  get commands(): readonly string[] {
    return this.#commands;
  }

  async run(): Promise<VerifierResult> {
    const chunks: string[] = [];
    let lastCode = 0;

    for (const command of this.#commands) {
      const result = await runShell(command, this.#cwd);
      chunks.push(`$ ${command}\n${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`);
      if (result.code !== 0) {
        lastCode = result.code;
        return {
          ok: false,
          commands: this.#commands,
          output: chunks.join("\n\n").trim(),
          exitCode: lastCode,
        };
      }
    }

    return {
      ok: true,
      commands: this.#commands,
      output: chunks.join("\n\n").trim(),
      exitCode: 0,
    };
  }
}

async function runShell(
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    return {
      stdout: typeof stdout === "string" ? stdout : "",
      stderr: typeof stderr === "string" ? stderr : "",
      code: 0,
    };
  } catch (error) {
    const err = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : (err.message ?? String(error)),
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}
