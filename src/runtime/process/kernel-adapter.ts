/**
 * Kernel-backed implementation of the `runSupervisedProcess` contract.
 *
 * Execution facts come from `@xioflow/kernel`; the product-facing contract
 * (`ProcessRunOptions` → `ProcessRunResult`) stays unchanged:
 *
 *   session → Task, turn → Run, one command → one Operation
 *   (intent_registered → active → done, with recovery-visible facts)
 *   AbortSignal → `cancelOperation(opId, termGraceMs)` confirmed stop pipeline
 *
 * Mapping table (product → kernel):
 *
 * | ProcessRunOptions     | kernel                                                        |
 * | --------------------- | ------------------------------------------------------------- |
 * | command/args/cwd      | `StructuredCommand.execPath/args/cwd`                         |
 * | env                   | `envWhiteList` (exact, `inheritEnv: false`; never merged)      |
 * | stdin                 | `StructuredCommand.stdin` (one-shot pipe, closed after write)  |
 * | timeoutMs             | `timeoutMs` (timeout runs the confirmed stop pipeline)         |
 * | termGraceMs           | `cancelOperation(opId, termGraceMs)` grace                     |
 * | output.head+tail      | `maxOutputBytes` (bounded in-memory retention)                 |
 * | output.hardCapBytes   | `resourceBudget.maxOutputBytes` + `enforcement: 'soft'`        |
 *
 * Facts mapped back: per-stream truncation, spill refs (`spillPaths`), bytes
 * seen, spawn failure, residual-descendant reaping, and the kernel's stop
 * reasons (see `mapKernelTermination`).
 *
 * Known, explicit gaps (documented instead of silently swallowed):
 * - `killDeadlineMs` has no kernel counterpart: SIGKILL confirmation windows
 *   are owned by the platform driver.
 * - `onOutput` chunk streaming is not forwarded by the kernel, so callers that
 *   need live output (`plan/parallel-dispatch.ts`) must keep using the legacy
 *   supervisor until the kernel grows a projection callback.
 * - Windows is not supported by the kernel; `kernelProcessFlag()` reports the
 *   flag as disabled there rather than degrading silently.
 *
 * The kernel imports `node:sqlite`, so this module must stay out of static
 * import graphs that run on Node < 22.5: load it with a dynamic `import()`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ExecutionDomain,
  NodePlatformDriver,
  ProcessSupervisor,
  RecoveryEngine,
  type IndeterminateResult,
  type PlatformDriver,
  type ProcessOperationResult,
  type RecoveryReport,
  type TerminationReason,
} from "@xioflow/kernel";

import { OUTPUT_BUDGET_PRESETS, type OutputBudget } from "./output-collector.ts";
import type {
  CleanupGuarantee,
  ProcessRunOptions,
  ProcessRunResult,
  ProcessTermination,
} from "./process-supervisor.ts";

export { KERNEL_PROCESS_FLAG, kernelProcessFlag } from "./kernel-process-flag.ts";
export type { KernelProcessFlag } from "./kernel-process-flag.ts";

const DEFAULT_TERM_GRACE_MS = 500;

export type KernelProcessContext = Readonly<{
  /** One Task per session; also the Run owner recorded in the kernel store. */
  sessionId: string;
  /** One Run per turn; defaults to `turn`. */
  turnId?: string;
  /** Domain directory (domain.db, domain.lock, artifacts/); defaults under ~/.xiocode/kernel. */
  domainPath?: string;
  /** Injectable driver for tests; defaults to the real Node platform driver. */
  driver?: PlatformDriver;
}>;

export class KernelProcessRunner {
  readonly #context: KernelProcessContext;
  #domain: ExecutionDomain | undefined;
  #supervisor: ProcessSupervisor | undefined;
  #recoveryStarted = false;
  #lastRecoveryReport: RecoveryReport | undefined;
  #closed = false;
  #sequence = 0;

  constructor(context: KernelProcessContext) {
    this.#context = context;
  }

  get sessionId(): string {
    return this.#context.sessionId;
  }

  get turnId(): string {
    return this.#context.turnId ?? "turn";
  }

  get domainPath(): string {
    return this.#context.domainPath
      ?? path.join(os.homedir(), ".xiocode", "kernel", sanitizeId(this.sessionId));
  }

  get taskId(): string {
    return `session-${sanitizeId(this.sessionId)}`;
  }

  get runId(): string {
    return `run-${sanitizeId(this.sessionId)}-${sanitizeId(this.turnId)}`;
  }

  /** Recovery verdict from the previous owner of this domain, when there was one. */
  get lastRecoveryReport(): RecoveryReport | undefined {
    return this.#lastRecoveryReport;
  }

  /** Acquires (once) the execution domain and registers Task + Run up front. */
  ensureDomain(): ExecutionDomain {
    if (this.#closed) {
      throw new Error(`KernelProcessRunner for session ${this.sessionId} is closed`);
    }
    if (!this.#domain) {
      const domain = ExecutionDomain.acquire(this.domainPath, sanitizeId(this.sessionId));
      this.#domain = domain;
      this.#supervisor = new ProcessSupervisor(
        domain,
        this.#context.driver ?? new NodePlatformDriver(),
      );
      const store = domain.getStore();
      if (!store.getTask(this.taskId)) {
        store.saveTask({
          id: this.taskId,
          domainId: domain.domainId,
          name: `session ${this.sessionId}`,
          createdAt: new Date().toISOString(),
        });
      }
      if (!store.getRun(this.runId)) {
        store.saveRun({
          id: this.runId,
          taskId: this.taskId,
          domainId: domain.domainId,
          owner: this.sessionId,
          status: "running",
          startedAt: new Date().toISOString(),
        });
      }
    }
    return this.#domain;
  }

  /** Marks the current turn's Run terminal. Rejected by the store while operations are unfinished. */
  endTurn(
    status: "succeeded" | "failed" | "cancelled" = "succeeded",
    reason?: TerminationReason,
  ): void {
    const store = this.#domain?.getStore();
    if (!store) {
      return;
    }
    if (status === "succeeded") {
      // Kernel completion protocol: refuses to finish a Run with unfinished or
      // indeterminate operations instead of faking a successful turn.
      store.reportRunSucceeded(this.runId);
      return;
    }
    if (status === "failed") {
      store.reportRunFailed(this.runId, reason);
      return;
    }
    store.updateRunStatus(this.runId, "cancelled", reason, new Date().toISOString());
  }

  close(): void {
    this.#closed = true;
    const domain = this.#domain;
    this.#domain = undefined;
    this.#supervisor = undefined;
    domain?.close();
  }

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const started = Date.now();
    const cleanupGuarantee = resolveCleanupGuarantee();
    if (options.signal?.aborted) {
      return abortedBeforeStart(started, cleanupGuarantee, "aborted before start");
    }

    this.ensureDomain();
    const supervisor = this.#supervisor;
    if (!supervisor) {
      throw new Error(`KernelProcessRunner for session ${this.sessionId} has no supervisor`);
    }

    const budget = options.output ?? OUTPUT_BUDGET_PRESETS.bash;
    const opId = `${sanitizeId(this.sessionId)}-${sanitizeId(this.turnId)}-${++this.#sequence}`;
    const termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;

    await this.#recoverPreviousOwner();

    const pending = supervisor.executeProcess({
      runId: this.runId,
      opId,
      name: `process:${options.command}`,
      command: {
        execPath: options.command,
        args: [...(options.args ?? [])],
        cwd: options.cwd,
        stdin: options.stdin,
        // Product semantics: callers pass an explicit scrubbed env; never inherit.
        envWhiteList: { ...(options.env ?? {}) } as Record<string, string>,
        inheritEnv: false,
      },
      // Per-operation lease: the product owns session admission, so the kernel
      // must not invent cross-command contention here.
      requiredResources: [`process:${opId}`],
      timeoutMs: options.timeoutMs,
      maxOutputBytes: Math.max(budget.headBytes + budget.tailBytes, 1),
      // The drain window only elapses when a descendant keeps the pipes open;
      // after it, the kernel reaps the group and keeps the root's exit facts.
      drainTimeoutMs: Math.max(termGraceMs, 100),
      resourceBudget: budget.hardCapBytes > 0
        ? { maxOutputBytes: budget.hardCapBytes, enforcement: "soft" }
        : undefined,
    });

    const onAbort = (): void => {
      void supervisor.cancelOperation(opId, termGraceMs);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const kernelResult = await pending;
      return toProcessRunResult(kernelResult, { budget, started, cleanupGuarantee });
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * A domain may still hold operations from a crashed process. Adjudicate them
   * with the kernel's RecoveryEngine before admitting anything new: confirmed
   * dead processes release their leases, unverifiable ones stay isolated.
   */
  async #recoverPreviousOwner(): Promise<void> {
    if (this.#recoveryStarted) {
      return;
    }
    this.#recoveryStarted = true;
    const domain = this.#domain;
    const supervisor = this.#supervisor;
    if (!domain || !supervisor) {
      return;
    }
    if (domain.getStore().getUnfinishedOperations(domain.domainId).length === 0) {
      return;
    }
    this.#lastRecoveryReport = await new RecoveryEngine(domain, supervisor.getDriver()).recover();
  }
}

let transientCounter = 0;

/**
 * One-shot convenience wrapper. Prefer `KernelProcessRunner` when several
 * commands share a session, so the domain is acquired once.
 */
export async function runSupervisedProcessViaKernel(
  options: ProcessRunOptions,
  context: KernelProcessContext,
): Promise<ProcessRunResult> {
  const runner = new KernelProcessRunner({
    ...context,
    turnId: context.turnId ?? `turn-${++transientCounter}`,
  });
  try {
    return await runner.run(options);
  } finally {
    runner.close();
  }
}

type ResultContext = Readonly<{
  budget: OutputBudget;
  started: number;
  cleanupGuarantee: CleanupGuarantee;
}>;

function toProcessRunResult(
  kernelResult: ProcessOperationResult | IndeterminateResult,
  context: ResultContext,
): ProcessRunResult {
  const durationMs = kernelResult.durationMs || Date.now() - context.started;
  const base = {
    durationMs,
    cleanupGuarantee: context.cleanupGuarantee,
  } as const;

  if (isIndeterminate(kernelResult)) {
    return {
      ...base,
      code: 1,
      signal: null,
      stdout: "",
      stderr: kernelResult.reason,
      timedOut: false,
      aborted: false,
      outputLimited: false,
      termination: "cleanup_failed",
      cleanupError: kernelResult.reason,
      stdoutTruncated: false,
      stderrTruncated: false,
      bytesSeen: { stdout: 0, stderr: 0 },
      peakRetainedBytes: 0,
    };
  }

  if (kernelResult.spawnFailure) {
    // Legacy contract: a binary that never started is `code: 1` + `spawn_error`.
    return {
      ...base,
      code: 1,
      signal: null,
      stdout: "",
      stderr: kernelResult.spawnFailure,
      timedOut: false,
      aborted: false,
      outputLimited: false,
      termination: "spawn_error",
      stdoutTruncated: false,
      stderrTruncated: false,
      bytesSeen: { stdout: 0, stderr: 0 },
      peakRetainedBytes: 0,
    };
  }

  const stdoutTruncated = kernelResult.stdoutTruncated === true;
  const stderrTruncated = kernelResult.stderrTruncated === true;
  const stdoutBytes = kernelResult.stdoutBytes ?? 0;
  const stderrBytes = kernelResult.stderrBytes ?? 0;
  const stdout = projectStream(kernelResult.stdout, kernelResult.stdoutRef, stdoutTruncated, context.budget, stdoutBytes);
  const stderr = projectStream(kernelResult.stderr, kernelResult.stderrRef, stderrTruncated, context.budget, stderrBytes);
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
    stdout,
    stderr,
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
  };
}

/**
 * Kernel stop reason → product termination vocabulary. Resource-governance
 * stops have no product equivalent, so they surface as `cleanup_failed` with
 * the kernel reason preserved in `cleanupError` instead of being flattened.
 */
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
  }
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

function resolveCleanupGuarantee(): CleanupGuarantee {
  return process.platform === "win32" ? "best_effort" : "posix_process_group";
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

function sanitizeId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized.slice(0, 64) : "session";
}
