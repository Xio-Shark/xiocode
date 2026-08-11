/**
 * ProcessTreeSupervisor — owned child lifecycle with real AbortSignal,
 * wall timeout, POSIX process-group TERM→KILL, and bounded output capture.
 *
 * Windows: best-effort `taskkill /T` (no Job Object claim).
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import {
  BoundedOutputCollector,
  OUTPUT_BUDGET_PRESETS,
  type OutputBudget,
  type OutputChunkProjection,
} from "./output-collector.ts";

export type ProcessTermination =
  | "exited"
  | "aborted"
  | "timed_out"
  | "output_limit"
  | "spawn_error"
  | "cleanup_failed";

export type CleanupGuarantee = "posix_process_group" | "best_effort";

export type ProcessRunOptions = Readonly<{
  command: string;
  args?: readonly string[];
  cwd: string;
  /** Explicit env only — never silently merge process.env here. */
  env?: NodeJS.ProcessEnv;
  stdin?: Uint8Array | string;
  signal?: AbortSignal;
  /** Wall timeout; omit / ≤0 disables. */
  timeoutMs?: number;
  termGraceMs?: number;
  killDeadlineMs?: number;
  output?: OutputBudget;
  onOutput?: (chunk: OutputChunkProjection) => void;
  /**
   * Test seam: override platform tree termination.
   * Return true when the tree is gone; false to signal cleanup_failed.
   */
  terminateTree?: (pid: number, phase: "term" | "kill") => boolean | Promise<boolean>;
  /**
   * Test seam: override liveness probe for owned tree.
   */
  isTreeAlive?: (pid: number) => boolean;
}>;

export type ProcessRunResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  outputLimited: boolean;
  durationMs: number;
  termination: ProcessTermination;
  cleanupError?: string;
  cleanupGuarantee: CleanupGuarantee;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  bytesSeen: Readonly<{ stdout: number; stderr: number }>;
  peakRetainedBytes: number;
  spillPaths?: Readonly<{ stdout?: string; stderr?: string }>;
}>;

const DEFAULT_TERM_GRACE_MS = 500;
const DEFAULT_KILL_DEADLINE_MS = 1_000;

/**
 * Run argv under a supervised process tree with bounded stdout/stderr.
 * Shell selection is the caller's responsibility — this never wraps `/bin/sh`.
 */
export async function runSupervisedProcess(
  options: ProcessRunOptions,
): Promise<ProcessRunResult> {
  const started = Date.now();
  const posix = process.platform !== "win32";
  const cleanupGuarantee: CleanupGuarantee = posix ? "posix_process_group" : "best_effort";
  const termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const killDeadlineMs = options.killDeadlineMs ?? DEFAULT_KILL_DEADLINE_MS;
  const outputBudget = options.output ?? OUTPUT_BUDGET_PRESETS.bash;

  if (options.signal?.aborted) {
    return abortedBeforeStart(started, cleanupGuarantee, "aborted before start");
  }

  const collector = new BoundedOutputCollector(outputBudget, {
    onOutput: options.onOutput,
  });

  let child: ChildProcessByStdio<Writable | null, Readable, Readable>;
  try {
    child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      // Never inherit process.env — callers must pass an explicit scrubbed env.
      env: options.env ?? {},
      detached: posix,
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
  } catch (error) {
    return {
      code: 1,
      signal: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
      aborted: false,
      outputLimited: false,
      durationMs: Date.now() - started,
      termination: "spawn_error",
      cleanupGuarantee,
      stdoutTruncated: false,
      stderrTruncated: false,
      bytesSeen: { stdout: 0, stderr: 0 },
      peakRetainedBytes: 0,
    };
  }

  const pid = child.pid;
  let timedOut = false;
  let aborted = false;
  let outputLimited = false;
  let spawnError: string | undefined;
  let cleanup: Promise<string | undefined> | undefined;

  const isTreeAlive =
    options.isTreeAlive ??
    ((targetPid: number) => isOwnedTreeAlive(targetPid, posix));

  const startCleanup = (reason: "abort" | "timeout" | "output_limit" | "exit") => {
    cleanup ??= terminateOwnedTree({
      pid,
      posix,
      termGraceMs,
      killDeadlineMs,
      reason,
      terminateTree: options.terminateTree,
      isTreeAlive,
    });
    return cleanup;
  };

  const onAbort = () => {
    aborted = true;
    void startCleanup("abort");
  };
  if (options.signal) {
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  let timeoutTimer: NodeJS.Timeout | undefined;
  if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      void startCleanup("timeout");
    }, options.timeoutMs);
    timeoutTimer.unref?.();
  }

  child.stdout.on("data", (chunk: Buffer) => {
    if (collector.push("stdout", chunk)) {
      outputLimited = true;
      void startCleanup("output_limit");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (collector.push("stderr", chunk)) {
      outputLimited = true;
      void startCleanup("output_limit");
    }
  });

  if (options.stdin !== undefined && child.stdin) {
    const payload = typeof options.stdin === "string"
      ? Buffer.from(options.stdin)
      : Buffer.from(options.stdin);
    child.stdin.on("error", () => {
      // Hook may exit before reading stdin (EPIPE) — surfaced via exit code.
    });
    child.stdin.end(payload);
  }

  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("error", (error) => {
      spawnError = error.message;
      resolve({ code: 1, signal: null });
    });
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  if (timeoutTimer) {
    clearTimeout(timeoutTimer);
  }
  options.signal?.removeEventListener("abort", onAbort);

  // Always reap owned tree (handles descendants holding pipes after root exit).
  const cleanupError = await startCleanup(
    aborted ? "abort" : timedOut ? "timeout" : outputLimited ? "output_limit" : "exit",
  );
  await closed;
  const snapshot = await collector.finalize();

  const termination = resolveTermination({
    spawnError,
    cleanupError,
    aborted,
    timedOut,
    outputLimited,
  });

  const spillPaths = {
    ...(snapshot.stdout.spillPath ? { stdout: snapshot.stdout.spillPath } : {}),
    ...(snapshot.stderr.spillPath ? { stderr: snapshot.stderr.spillPath } : {}),
  };

  return {
    code: spawnError ? 1 : exit.code,
    signal: exit.signal,
    stdout: snapshot.stdout.text,
    stderr: spawnError
      ? (snapshot.stderr.text.length > 0 ? snapshot.stderr.text : spawnError)
      : snapshot.stderr.text,
    timedOut,
    aborted,
    outputLimited,
    durationMs: Date.now() - started,
    termination,
    ...(cleanupError ? { cleanupError } : {}),
    cleanupGuarantee,
    stdoutTruncated: snapshot.stdout.truncated,
    stderrTruncated: snapshot.stderr.truncated,
    bytesSeen: {
      stdout: snapshot.stdout.bytesSeen,
      stderr: snapshot.stderr.bytesSeen,
    },
    peakRetainedBytes: snapshot.peakRetainedBytes,
    ...(Object.keys(spillPaths).length > 0 ? { spillPaths } : {}),
  };
}

/**
 * Force-kill an already-running pid tree (MCP / orphaned stdio children).
 * POSIX: process-group when `processGroup` is true; otherwise best-effort
 * descendant walk + direct kill. Windows: `taskkill /T`.
 *
 * Fire-and-forget safe — errors ignored.
 */
export function forceKillProcessTree(
  pid: number | null | undefined,
  options: Readonly<{ processGroup?: boolean }> = {},
): void {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) {
    return;
  }
  const posix = process.platform !== "win32";
  const processGroup = options.processGroup ?? posix;
  void terminateOwnedTree({
    pid,
    posix,
    termGraceMs: DEFAULT_TERM_GRACE_MS,
    killDeadlineMs: DEFAULT_KILL_DEADLINE_MS,
    reason: "abort",
    forceDirectAlso: !processGroup,
    processGroup,
  });
}

export function createDeadlineSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): Readonly<{ signal: AbortSignal; dispose: () => void; timedOut: () => boolean }> {
  const controller = new AbortController();
  let timedOut = false;
  const onParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(parent?.reason ?? new Error("aborted"));
    }
  };
  if (parent) {
    if (parent.aborted) {
      onParent();
    } else {
      parent.addEventListener("abort", onParent, { once: true });
    }
  }
  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      timedOut = true;
      if (!controller.signal.aborted) {
        controller.abort(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
      }
    }, timeoutMs);
    timer.unref?.();
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

async function terminateOwnedTree(options: Readonly<{
  pid: number | undefined;
  posix: boolean;
  termGraceMs: number;
  killDeadlineMs: number;
  reason: string;
  processGroup?: boolean;
  forceDirectAlso?: boolean;
  terminateTree?: (pid: number, phase: "term" | "kill") => boolean | Promise<boolean>;
  isTreeAlive?: (pid: number) => boolean;
}>): Promise<string | undefined> {
  const pid = options.pid;
  if (pid === undefined) {
    return undefined;
  }
  const processGroup = options.processGroup ?? options.posix;
  const alive = options.isTreeAlive ?? ((p: number) => isOwnedTreeAlive(p, processGroup && options.posix));

  if (options.terminateTree) {
    await options.terminateTree(pid, "term");
    if (await waitUntil(() => !alive(pid), options.termGraceMs)) {
      return undefined;
    }
    await options.terminateTree(pid, "kill");
    return await waitUntil(() => !alive(pid), options.killDeadlineMs)
      ? undefined
      : `process tree ${String(pid)} remained alive after SIGKILL`;
  }

  if (!options.posix) {
    await windowsTaskKill(pid, false);
    if (await waitUntil(() => !alive(pid), options.termGraceMs)) {
      return undefined;
    }
    await windowsTaskKill(pid, true);
    return await waitUntil(() => !alive(pid), options.killDeadlineMs)
      ? undefined
      : `process tree ${String(pid)} remained alive after taskkill /F /T`;
  }

  const target = processGroup ? -pid : pid;
  if (!alive(pid)) {
    return undefined;
  }
  signalTarget(target, "SIGTERM");
  if (options.forceDirectAlso && processGroup) {
    signalTarget(pid, "SIGTERM");
  }
  if (!processGroup) {
    await killDescendantsBestEffort(pid, "SIGTERM");
  }
  if (await waitUntil(() => !alive(pid), options.termGraceMs)) {
    return undefined;
  }
  signalTarget(target, "SIGKILL");
  if (options.forceDirectAlso && processGroup) {
    signalTarget(pid, "SIGKILL");
  }
  if (!processGroup) {
    await killDescendantsBestEffort(pid, "SIGKILL");
  }
  return await waitUntil(() => !alive(pid), options.killDeadlineMs)
    ? undefined
    : `process group ${String(pid)} remained alive after SIGKILL`;
}

function isOwnedTreeAlive(pid: number, processGroup: boolean): boolean {
  try {
    process.kill(processGroup ? -pid : pid, 0);
    return true;
  } catch {
    if (processGroup) {
      // Group probe can fail while the root pid still exists briefly.
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function signalTarget(target: number, value: NodeJS.Signals): void {
  try {
    process.kill(target, value);
  } catch {
    // exited between liveness check and signal
  }
}

async function killDescendantsBestEffort(pid: number, signal: NodeJS.Signals): Promise<void> {
  const children = await listChildPids(pid);
  for (const child of children) {
    await killDescendantsBestEffort(child, signal);
    signalTarget(child, signal);
  }
}

async function listChildPids(pid: number): Promise<number[]> {
  return await new Promise((resolve) => {
    const child = spawn("pgrep", ["-P", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > 64_000) {
        child.kill("SIGKILL");
      }
    });
    child.on("close", () => {
      resolve(
        out
          .split("\n")
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((n) => Number.isInteger(n) && n > 0),
      );
    });
    child.on("error", () => resolve([]));
  });
}

async function windowsTaskKill(pid: number, force: boolean): Promise<void> {
  const args = force
    ? ["/PID", String(pid), "/T", "/F"]
    : ["/PID", String(pid), "/T"];
  await new Promise<void>((resolve) => {
    const child = spawn("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 3_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function resolveTermination(flags: Readonly<{
  spawnError?: string;
  cleanupError?: string;
  aborted: boolean;
  timedOut: boolean;
  outputLimited: boolean;
}>): ProcessTermination {
  if (flags.spawnError) return "spawn_error";
  if (flags.cleanupError) return "cleanup_failed";
  if (flags.outputLimited) return "output_limit";
  if (flags.timedOut) return "timed_out";
  if (flags.aborted) return "aborted";
  return "exited";
}

function abortedBeforeStart(
  started: number,
  cleanupGuarantee: CleanupGuarantee,
  message: string,
): ProcessRunResult {
  return {
    code: 1,
    signal: null,
    stdout: "",
    stderr: message,
    timedOut: false,
    aborted: true,
    outputLimited: false,
    durationMs: Date.now() - started,
    termination: "aborted",
    cleanupGuarantee,
    stdoutTruncated: false,
    stderrTruncated: false,
    bytesSeen: { stdout: 0, stderr: 0 },
    peakRetainedBytes: 0,
  };
}
