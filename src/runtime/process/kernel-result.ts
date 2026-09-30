/**
 * Kernel facts → the product's `ProcessRunResult` contract.
 *
 * Pure mapping, no domain access: the kernel session decides *what* ran, this
 * module only decides how the product reads it. Resource-governance stops have
 * no product equivalent, so they surface as `cleanup_failed` with the kernel
 * reason preserved instead of being flattened.
 */

import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

import type {
  IndeterminateResult,
  ProcessOperationResult,
  TerminationReason,
} from "@xioflow/kernel";

import { adjudicationHint } from "./kernel-hint.ts";
import type { OutputBudget, OutputChunkProjection, OutputStreamName } from "./output-collector.ts";
import type {
  CleanupGuarantee,
  KernelOperationRef,
  ProcessRunResult,
  ProcessTermination,
} from "./process-supervisor.ts";

export type ResultContext = Readonly<{
  budget: OutputBudget;
  started: number;
  cleanupGuarantee: CleanupGuarantee;
  opId: string;
  domainPath: string;
}>;

export function toProcessRunResult(
  kernelResult: ProcessOperationResult | IndeterminateResult,
  context: ResultContext,
): ProcessRunResult {
  const durationMs = kernelResult.durationMs || Date.now() - context.started;
  const kernel: KernelOperationRef = {
    opId: context.opId,
    domainPath: context.domainPath,
    ...(kernelResult.replayed ? { replayed: true } : {}),
  };
  const base = { durationMs, cleanupGuarantee: context.cleanupGuarantee } as const;

  if (isIndeterminate(kernelResult)) {
    const guidance = `kernel: operation ${context.opId} is indeterminate — its process could not be `
      + `confirmed stopped, so the workspace lease stays held. ${adjudicationHint(context.opId, context.domainPath)}.`;
    return {
      ...base,
      ...emptyOutput(),
      code: 1,
      signal: null,
      stderr: `${kernelResult.reason}\n${guidance}`,
      termination: "cleanup_failed",
      cleanupError: kernelResult.reason,
      kernel: { ...kernel, indeterminate: true },
    };
  }

  if (kernelResult.spawnFailure) {
    // Legacy contract: a binary that never started is `code: 1` + `spawn_error`.
    return {
      ...base,
      ...emptyOutput(),
      code: 1,
      signal: null,
      stderr: kernelResult.spawnFailure,
      termination: "spawn_error",
      kernel,
    };
  }

  const stdoutTruncated = kernelResult.stdoutTruncated === true;
  const stderrTruncated = kernelResult.stderrTruncated === true;
  const stdoutBytes = kernelResult.stdoutBytes ?? 0;
  const stderrBytes = kernelResult.stderrBytes ?? 0;
  const terminationReason = kernelResult.terminationReason;
  const { termination, cleanupError } = mapKernelTermination(terminationReason);
  const spillPaths = {
    ...(stdoutTruncated && kernelResult.stdoutRef ? { stdout: kernelResult.stdoutRef } : {}),
    ...(stderrTruncated && kernelResult.stderrRef ? { stderr: kernelResult.stderrRef } : {}),
  };

  return {
    ...base,
    code: kernelResult.exitCode,
    signal: kernelResult.signal,
    stdout: projectStream(kernelResult.stdout, kernelResult.stdoutRef, stdoutTruncated, context.budget, stdoutBytes),
    stderr: projectStream(kernelResult.stderr, kernelResult.stderrRef, stderrTruncated, context.budget, stderrBytes),
    timedOut: terminationReason === "timed_out",
    aborted: terminationReason === "user_cancelled",
    outputLimited: terminationReason === "output_exceeded",
    termination,
    ...(cleanupError ? { cleanupError } : {}),
    stdoutTruncated,
    stderrTruncated,
    bytesSeen: { stdout: stdoutBytes, stderr: stderrBytes },
    peakRetainedBytes: retainedBytes(kernelResult, context.budget),
    ...(Object.keys(spillPaths).length > 0 ? { spillPaths } : {}),
    kernel,
  };
}

/**
 * The session refused to start a write because the workspace lease is held
 * (queue timeout, or the holder is indeterminate). Nothing was spawned.
 */
export function leaseRefusedResult(
  message: string,
  started: number,
  cleanupGuarantee: CleanupGuarantee,
  kernel: KernelOperationRef,
): ProcessRunResult {
  return {
    ...emptyOutput(),
    code: 1,
    signal: null,
    stderr: message,
    durationMs: Date.now() - started,
    termination: "spawn_error",
    cleanupGuarantee,
    kernel,
  };
}

export function mapKernelTermination(
  reason: TerminationReason | undefined,
): Readonly<{ termination: ProcessTermination; cleanupError?: string }> {
  switch (reason) {
    case undefined:
    case "completed":
      return { termination: "exited" };
    case "user_cancelled":
      return { termination: "aborted" };
    case "timed_out":
      return { termination: "timed_out" };
    case "output_exceeded":
      return { termination: "output_limit" };
    case "memory_exceeded":
    case "cpu_exceeded":
    case "pids_exceeded":
    case "resource_preempted":
      return {
        termination: "cleanup_failed",
        cleanupError: `kernel resource governance stopped the process (${reason})`,
      };
    case "crash_detected":
      return { termination: "cleanup_failed", cleanupError: "kernel reported crash_detected" };
    case "exit_unobserved":
      // Recovery saw the process gone but never saw its exit: the outcome is
      // unknown, so it must not read as a clean exit (or be retried blindly).
      return {
        termination: "cleanup_failed",
        cleanupError: "kernel: the process exited while XioCode was down; its outcome is unknown",
      };
  }
}

export function abortedBeforeStart(
  started: number,
  cleanupGuarantee: CleanupGuarantee,
  message: string,
): ProcessRunResult {
  return {
    ...emptyOutput(),
    code: 1,
    signal: null,
    stderr: message,
    aborted: true,
    durationMs: Date.now() - started,
    termination: "aborted",
    cleanupGuarantee,
  };
}

export function resolveCleanupGuarantee(): CleanupGuarantee {
  return process.platform === "win32" ? "best_effort" : "posix_process_group";
}

function emptyOutput() {
  return {
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
    outputLimited: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    bytesSeen: { stdout: 0, stderr: 0 },
    peakRetainedBytes: 0,
  } as const;
}

/**
 * Rebuilds the product's head/tail shape on top of the kernel's facts: the
 * kernel retains the head in memory and spills the full stream to an artifact,
 * so the tail is read back from that spill file when the stream was truncated.
 */
function projectStream(
  kernelHead: string,
  spillRef: string | undefined,
  truncated: boolean,
  budget: OutputBudget,
  bytesSeen: number,
): string {
  if (!truncated) {
    return kernelHead;
  }
  const head = budget.headBytes > 0 ? kernelHead.slice(0, budget.headBytes) : "";
  const tail = budget.tailBytes > 0 && spillRef ? readSpillTail(spillRef, budget.tailBytes) : undefined;
  const body = head.length === 0
    ? (tail ?? "")
    : tail && tail.length > 0
      ? `${head}\n…[truncated]…\n${tail}`
      : head;
  return spillRef
    ? `[process_output spilled: ${spillRef}; bytes_seen=${bytesSeen}]\n${body}`
    : body;
}

function readSpillTail(filePath: string, tailBytes: number): string | undefined {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(tailBytes, size);
      if (length <= 0) {
        return undefined;
      }
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // A missing spill file means "no tail available", never a fake tail.
    return undefined;
  }
}

function retainedBytes(result: ProcessOperationResult, budget: OutputBudget): number {
  const perStream = Math.max(budget.headBytes + budget.tailBytes, 0);
  const stdout = result.stdoutTruncated === true ? perStream : Buffer.byteLength(result.stdout, "utf8");
  const stderr = result.stderrTruncated === true ? perStream : Buffer.byteLength(result.stderr, "utf8");
  return stdout + stderr;
}

function isIndeterminate(
  value: ProcessOperationResult | IndeterminateResult,
): value is IndeterminateResult {
  return (value as IndeterminateResult).kind === "indeterminate";
}

const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

type LineProjectionState = {
  decoder: StringDecoder;
  lineBuffer: string;
};

/**
 * Rebuilds the product's `onOutput` line projection on top of the kernel's raw
 * chunk callback, keeping the legacy semantics: whole lines are emitted as they
 * arrive, an over-long line is trimmed to `maxLineBytes` (oldest bytes dropped,
 * reported through `droppedBytes`), and a trailing partial line stays buffered.
 */
export function createLineProjection(
  onOutput: (chunk: OutputChunkProjection) => void,
  budget: OutputBudget,
): Readonly<{ push: (stream: OutputStreamName, chunk: Buffer) => void }> {
  const maxLineBytes = budget.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const states: Record<OutputStreamName, LineProjectionState> = {
    stdout: { decoder: new StringDecoder("utf8"), lineBuffer: "" },
    stderr: { decoder: new StringDecoder("utf8"), lineBuffer: "" },
  };

  return {
    push(stream, chunk) {
      const state = states[stream];
      const decoded = state.decoder.write(chunk);
      if (!decoded) {
        return;
      }
      state.lineBuffer += decoded;
      let droppedBytes = 0;
      if (Buffer.byteLength(state.lineBuffer) > maxLineBytes) {
        const encoded = Buffer.from(state.lineBuffer);
        droppedBytes = encoded.byteLength - maxLineBytes;
        state.lineBuffer = encoded.subarray(encoded.byteLength - maxLineBytes).toString("utf8");
      }
      const newlineIndex = state.lineBuffer.lastIndexOf("\n");
      if (newlineIndex === -1 && Buffer.byteLength(state.lineBuffer) < Math.min(4_096, maxLineBytes)) {
        return;
      }
      if (newlineIndex === -1) {
        onOutput({ stream, text: state.lineBuffer, droppedBytes });
        state.lineBuffer = "";
        return;
      }
      const text = state.lineBuffer.slice(0, newlineIndex + 1);
      state.lineBuffer = state.lineBuffer.slice(newlineIndex + 1);
      onOutput({ stream, text, droppedBytes });
    },
  };
}
