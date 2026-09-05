/**
 * Eval/regress process runner — thin compatibility wrapper over the shared
 * ProcessTreeSupervisor. Callers keep the SpawnResult shape.
 */

import { buildChildEnv } from "../../../src/runtime/secret-environment.ts";
import { runSupervisedProcess } from "../../../src/runtime/process/index.ts";

export type SpawnResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  cleanupError?: string;
}>;

export async function spawnCommand(options: Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
}>): Promise<SpawnResult> {
  const maxOutputBytes = options.maxOutputBytes ?? Number.POSITIVE_INFINITY;
  if (maxOutputBytes < 0 || Number.isNaN(maxOutputBytes)) {
    throw new Error("maxOutputBytes must be non-negative");
  }
  // maxOutputBytes is a per-stream capture bound (legacy appendBounded), not a
  // kill trigger — use a very large aggregate hard cap so short commands can exit 0.
  const perStream = Number.isFinite(maxOutputBytes)
    ? maxOutputBytes
    : 16 * 1024 * 1024;
  const hardCap = Number.isFinite(maxOutputBytes)
    ? Math.max(maxOutputBytes * 4, 64 * 1024 * 1024)
    : 64 * 1024 * 1024;

  const result = await runSupervisedProcess({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    // Explicit env is final; omitted → scrubbed base (never inherit full host).
    env: options.env ?? buildChildEnv(process.env),
    timeoutMs: options.timeoutMs,
    output: {
      headBytes: perStream,
      tailBytes: 0,
      hardCapBytes: hardCap,
    },
  });

  if (result.termination === "spawn_error") {
    // Preserve legacy spawnCommand reject-on-ENOENT for regress INFRA_ERROR paths.
    throw new Error(result.stderr || `spawn ${options.command} failed`);
  }

  return {
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    ...(result.cleanupError ? { cleanupError: result.cleanupError } : {}),
  };
}
