import { spawn } from "node:child_process";

import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

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
  const started = Date.now();
  const detached = process.platform !== "win32";
  const maxOutputBytes = options.maxOutputBytes ?? Number.POSITIVE_INFINITY;
  if (maxOutputBytes < 0 || Number.isNaN(maxOutputBytes)) {
    throw new Error("maxOutputBytes must be non-negative");
  }
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = captureOutput(child, maxOutputBytes);
  let timedOut = false;
  let cleanup: Promise<string | undefined> | undefined;
  const startCleanup = () => {
    cleanup ??= terminateProcess(child.pid, detached);
    return cleanup;
  };
  const timer = setTimeout(() => {
    timedOut = true;
    void startCleanup();
  }, options.timeoutMs);
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  const cleanupError = await startCleanup();
  await closed;
  return {
    ...exit,
    stdout: output.stdout(),
    stderr: output.stderr(),
    timedOut,
    durationMs: Date.now() - started,
    ...(cleanupError ? { cleanupError } : {}),
  };
}

function captureOutput(
  child: ChildProcessByStdio<null, Readable, Readable>,
  maxOutputBytes = Number.POSITIVE_INFINITY,
): Readonly<{
  stdout: () => string;
  stderr: () => string;
}> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer | string) => {
    stdoutBytes = appendBounded(stdout, stdoutBytes, chunk, maxOutputBytes);
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrBytes = appendBounded(stderr, stderrBytes, chunk, maxOutputBytes);
  });
  return {
    stdout: () => Buffer.concat(stdout).toString("utf8"),
    stderr: () => Buffer.concat(stderr).toString("utf8"),
  };
}

function appendBounded(
  chunks: Buffer[],
  capturedBytes: number,
  chunk: Buffer | string,
  maxOutputBytes: number,
): number {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = maxOutputBytes - capturedBytes;
  if (remaining <= 0) return capturedBytes;
  const captured = buffer.subarray(0, remaining);
  chunks.push(captured);
  return capturedBytes + captured.byteLength;
}

async function terminateProcess(pid: number | undefined, detached: boolean): Promise<string | undefined> {
  if (pid === undefined) {
    return undefined;
  }
  const target = detached ? -pid : pid;
  if (!isAlive(target)) {
    return undefined;
  }
  signal(target, "SIGTERM");
  if (await waitUntilGone(target, 500)) {
    return undefined;
  }
  signal(target, "SIGKILL");
  return await waitUntilGone(target, 1_000)
    ? undefined
    : `process group ${String(pid)} remained alive after SIGKILL`;
}

async function waitUntilGone(target: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(target)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(target);
}

function isAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(target: number, value: NodeJS.Signals): void {
  try {
    process.kill(target, value);
  } catch {
    // The process group exited between the liveness check and signal.
  }
}
