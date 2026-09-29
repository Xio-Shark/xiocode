/**
 * One product session ↔ one kernel execution domain.
 *
 *   session → Task        turn → Run (`beginTurn` / `endTurn`)
 *   work outside a turn (MCP services, slash commands) → the launch Run
 *   one supervised command → one Operation
 *
 * The domain is opened once per launch. Recovery runs before any new Run is
 * created, so operations a crashed launch left behind are adjudicated and its
 * Runs converge instead of staying `running` forever.
 *
 * Writers share one lease, `workspace:write:<workspaceRoot>`: they queue FIFO
 * behind each other, and snapshot/rollback cannot run under them. Readers take
 * no lease. The domain is single-writer (one owning process), so the lease
 * arbitrates within a session; separate sessions get separate domains.
 *
 * The kernel imports `node:sqlite`; load this module with a dynamic `import()`.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ExecutionDomain,
  NodePlatformDriver,
  OperationNotActiveError,
  ProcessSupervisor,
  RecoveryEngine,
  ResourceConflictError,
  type AdjudicationRecord,
  type DomainStatus,
  type KernelRunStatus,
  type Operation,
  type PlatformDriver,
  type RecoveryReport,
  type RollbackOperationResult,
  type ServiceHandle,
  type ServiceSpec,
  type SnapshotRef,
} from "@xioflow/kernel";

import { OUTPUT_BUDGET_PRESETS } from "./output-collector.ts";
import type { KernelOperationRef, ProcessRunOptions, ProcessRunResult } from "./process-supervisor.ts";
import { adjudicationHint } from "./kernel-hint.ts";
import {
  abortedBeforeStart,
  createLineProjection,
  leaseRefusedResult,
  resolveCleanupGuarantee,
  toProcessRunResult,
} from "./kernel-result.ts";

const DEFAULT_TERM_GRACE_MS = 500;
/** Journal fact linking a product key (tool call id) to the operation it started. */
const OPERATION_KEY_EVENT = "XIOCODE_TOOL_OPERATION";
/** How long a writer queues behind another writer before it is refused. */
const DEFAULT_WRITE_LEASE_WAIT_MS = 15 * 60_000;

export type KernelSessionOptions = Readonly<{
  sessionId: string;
  /** Canonical (realpath) workspace root; the write lease and snapshots are scoped to it. */
  workspaceRoot: string;
  domainPath: string;
  /** Test seam; defaults to the real Node platform driver. */
  driver?: PlatformDriver;
  writeLeaseWaitMs?: number;
  /**
   * No product session behind it (tools used before binding, one-off CLIs):
   * a clean close deletes the domain instead of leaving one per launch. A
   * domain with unfinished or indeterminate work is kept for recovery.
   */
  ephemeral?: boolean;
}>;

export type KernelAcceptance = Readonly<{
  passed: boolean;
  summary: string;
  commands: readonly Readonly<{ name: string; exitCode: number; passed: boolean }>[];
}>;

export type KernelTurnOutcome = Readonly<{
  status: "succeeded" | "failed" | "cancelled";
  /** Done-contract verdict; a failed contract fails the Run even if the loop succeeded. */
  acceptance?: KernelAcceptance;
}>;

export type KernelRunEnd = Readonly<{ runId: string; status: KernelRunStatus }>;

export type KernelOperationFact = Readonly<{
  opId: string;
  status: Operation["status"];
  result?: Operation["result"];
}>;

export class KernelSession {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly domainPath: string;
  /** What recovery found from a previous owner of this domain; undefined when nothing was left. */
  readonly recoveryReport: RecoveryReport | undefined;

  readonly #domain: ExecutionDomain;
  readonly #supervisor: ProcessSupervisor;
  readonly #launchRunId: string;
  readonly #launchToken: string;
  readonly #writeLeaseWaitMs: number;
  readonly #ephemeral: boolean;
  #turnRunId: string | undefined;
  #sequence = 0;
  #closed = false;

  private constructor(
    options: KernelSessionOptions,
    domain: ExecutionDomain,
    supervisor: ProcessSupervisor,
    recoveryReport: RecoveryReport | undefined,
  ) {
    this.sessionId = options.sessionId;
    this.workspaceRoot = options.workspaceRoot;
    this.domainPath = options.domainPath;
    this.recoveryReport = recoveryReport;
    this.#domain = domain;
    this.#supervisor = supervisor;
    this.#writeLeaseWaitMs = options.writeLeaseWaitMs ?? DEFAULT_WRITE_LEASE_WAIT_MS;
    this.#ephemeral = options.ephemeral === true;
    this.#launchToken = crypto.randomBytes(4).toString("hex");
    this.#launchRunId = `${this.taskId}-launch-${this.#launchToken}`;
  }

  /** Acquires the domain, adjudicates leftovers, then registers Task + launch Run. */
  static async open(options: KernelSessionOptions): Promise<KernelSession> {
    const domain = ExecutionDomain.acquire(options.domainPath, sanitizeId(options.sessionId));
    try {
      const driver = options.driver ?? new NodePlatformDriver();
      const supervisor = new ProcessSupervisor(domain, driver);
      // Always recover: besides unfinished operations, this converges Runs a
      // crashed launch left `running`. It must happen before our own Runs exist.
      const report = await new RecoveryEngine(domain, driver).recover();
      const session = new KernelSession(
        options,
        domain,
        supervisor,
        report.recoveredOperations.length > 0 ? report : undefined,
      );
      session.#registerTaskAndLaunchRun();
      return session;
    } catch (error) {
      domain.close();
      throw error;
    }
  }

  get taskId(): string {
    return `session-${sanitizeId(this.sessionId)}`;
  }

  /** The Run new operations are attributed to: the open turn, else the launch Run. */
  get currentRunId(): string {
    return this.#turnRunId ?? this.#launchRunId;
  }

  get launchRunId(): string {
    return this.#launchRunId;
  }

  beginTurn(turnId: string): string {
    this.#assertOpen();
    if (this.#turnRunId) {
      throw new Error(`kernel session ${this.sessionId}: turn Run ${this.#turnRunId} is still open`);
    }
    const runId = `${this.taskId}-${sanitizeId(turnId)}`;
    this.#saveRun(runId);
    this.#turnRunId = runId;
    return runId;
  }

  /**
   * Reports the turn's Run through the kernel completion protocol. The kernel
   * refuses to succeed a Run with unfinished operations and downgrades one with
   * indeterminate operations; that refusal is thrown, never swallowed.
   */
  endTurn(outcome: KernelTurnOutcome): KernelRunEnd | undefined {
    const runId = this.#turnRunId;
    if (!runId) return undefined;
    this.#turnRunId = undefined;
    const store = this.#domain.getStore();
    if (outcome.acceptance) {
      this.recordFact("XIOCODE_ACCEPTANCE", { ...outcome.acceptance }, { runId });
    }
    const acceptanceFailed = outcome.acceptance?.passed === false;
    if (outcome.status === "cancelled") {
      this.#domain.reportRunCancelled(runId, "user_cancelled");
    } else if (outcome.status === "failed" || acceptanceFailed) {
      store.reportRunFailed(runId, "completed");
    } else {
      store.reportRunSucceeded(runId);
    }
    return { runId, status: store.getRun(runId)?.status ?? "failed" };
  }

  /** Appends a product fact to the kernel journal, attributed to the current Run. */
  recordFact(
    type: `XIOCODE_${string}`,
    payload: Record<string, unknown>,
    options: Readonly<{ runId?: string; opId?: string }> = {},
  ): number {
    this.#assertOpen();
    return this.#domain.getStore().recordJournalEvent({
      domainId: this.#domain.domainId,
      runId: options.runId ?? this.currentRunId,
      operationId: options.opId,
      type,
      payload,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * What the kernel recorded for the latest operation submitted under `key`
   * (a tool call id). Undefined when nothing reached the kernel: the mapping
   * is journaled before the intent, so a crash in between also reads as
   * "never started".
   */
  getOperationByKey(key: string): KernelOperationFact | undefined {
    const store = this.#domain.getStore();
    const mapping = store.getJournalEvents(this.#domain.domainId)
      .filter((event) => event.type === OPERATION_KEY_EVENT && event.payload.key === key)
      .at(-1);
    const opId = typeof mapping?.payload.opId === "string" ? mapping.payload.opId : undefined;
    const op = opId ? store.getOperation(opId) : null;
    return op ? { opId: op.id, status: op.status, result: op.result } : undefined;
  }

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const started = Date.now();
    const cleanupGuarantee = resolveCleanupGuarantee();
    if (options.signal?.aborted) {
      return abortedBeforeStart(started, cleanupGuarantee, "aborted before start");
    }
    this.#assertOpen();

    const budget = options.output ?? OUTPUT_BUDGET_PRESETS.bash;
    // Operation ids stay unique per execution. Tool call ids are not a safe
    // identity: some providers number them per response (`call_0`), and a
    // reused opId would make the kernel replay an earlier run's result.
    const opId = this.#oneOffOpId("proc");
    const ref: KernelOperationRef = { opId, domainPath: this.domainPath };
    const termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
    const leaseRoot = options.access === "read" ? undefined : this.#leaseRootFor(options.cwd);
    const resources = leaseRoot ? [writeLease(leaseRoot)] : [];

    const holder = leaseRoot ? this.#leaseHolder(writeLease(leaseRoot)) : undefined;
    if (holder?.indeterminate) {
      return leaseRefusedResult(
        `kernel: workspace is locked by indeterminate operation ${holder.opId} (${holder.name}); `
          + `nothing was started. ${adjudicationHint(holder.opId, this.domainPath)}.`,
        started,
        cleanupGuarantee,
        ref,
      );
    }

    if (options.operationKey) {
      this.recordFact(OPERATION_KEY_EVENT, { key: options.operationKey, opId }, { opId });
    }
    const projection = options.onOutput ? createLineProjection(options.onOutput, budget) : undefined;
    const pending = this.#supervisor.executeProcess({
      runId: this.currentRunId,
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
      requiredResources: resources,
      ...(leaseRoot ? { mutationRoots: [leaseRoot], waitTimeoutMs: this.#writeLeaseWaitMs } : {}),
      timeoutMs: options.timeoutMs,
      maxOutputBytes: Math.max(budget.headBytes + budget.tailBytes, 1),
      // The drain window only elapses when a descendant keeps the pipes open;
      // after it, the kernel reaps the group and keeps the root's exit facts.
      drainTimeoutMs: Math.max(termGraceMs, 100),
      resourceBudget: budget.hardCapBytes > 0
        ? { maxOutputBytes: budget.hardCapBytes, enforcement: "soft" }
        : undefined,
      ...(projection ? { onStreamChunk: projection.push } : {}),
    });

    const onAbort = (): void => {
      this.#supervisor.cancelOperation(opId, termGraceMs).catch((err) => {
        // not_found / already_completed are normal races when cancelled late.
        if (err instanceof OperationNotActiveError
          && (err.reason === "not_found" || err.reason === "already_completed")) {
          return;
        }
        process.stderr.write(`xiocode: kernel cancelOperation failed for ${opId}: ${String(err)}\n`);
      });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = toProcessRunResult(await pending, {
        budget, started, cleanupGuarantee, opId, domainPath: this.domainPath,
      });
      return holder ? withQueueNote(result, holder) : result;
    } catch (err) {
      if (err instanceof ResourceConflictError) {
        return leaseRefusedResult(
          `kernel: gave up after ${Math.round(err.waitedDurationMs / 1000)}s waiting for ${err.resourceId}, `
            + `held by ${this.#describeOperation(err.existingOwnerOpId)}; nothing was started.`,
          started,
          cleanupGuarantee,
          ref,
        );
      }
      throw err;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async captureSnapshot(): Promise<SnapshotRef> {
    this.#assertOpen();
    const result = await this.#supervisor.captureSnapshot({
      runId: this.currentRunId,
      opId: this.#oneOffOpId("snap"),
      roots: [this.workspaceRoot],
    });
    if (result.status !== "succeeded" || !result.snapshot) {
      throw new Error(`kernel snapshot failed: ${result.errorMessage ?? "no snapshot recorded"}`);
    }
    return result.snapshot;
  }

  listSnapshotIds(): string[] {
    return this.#domain.getStore().listSnapshots(this.#domain.domainId).map((snapshot) => snapshot.id);
  }

  getSnapshot(snapshotId: string): SnapshotRef | undefined {
    return this.#domain.getStore().getSnapshot(snapshotId) ?? undefined;
  }

  /** Tree id of the workspace as it is now, measured the way `snapshot` was taken (for diffs). */
  async currentTreeAgainst(snapshot: SnapshotRef): Promise<string> {
    return this.#supervisor.getSnapshotDriver().fingerprint(snapshot.roots, { against: snapshot });
  }

  async rollback(snapshotId: string): Promise<RollbackOperationResult> {
    this.#assertOpen();
    return this.#supervisor.rollback({
      runId: this.currentRunId,
      opId: this.#oneOffOpId("rollback"),
      snapshotId,
    });
  }

  async pruneSnapshots(snapshotIds: readonly string[]): Promise<string[]> {
    if (snapshotIds.length === 0) return [];
    return this.#supervisor.pruneSnapshots([...snapshotIds], { runId: this.currentRunId });
  }

  /**
   * Long-running services (MCP stdio servers) belong to the launch Run: they
   * outlive turns. Service ids are made unique per launch because instance
   * operation ids (`<serviceId>#<n>`) are unique across the whole domain.
   */
  async startService(
    name: string,
    spec: Omit<ServiceSpec, "runId" | "artifactsDir" | "serviceId">,
  ): Promise<ServiceHandle> {
    this.#assertOpen();
    return this.#supervisor.startService({
      ...spec,
      serviceId: `svc-${this.#launchToken}-${sanitizeId(name)}-${++this.#sequence}`,
      runId: this.#launchRunId,
      artifactsDir: path.join(this.domainPath, "artifacts"),
    });
  }

  status(): DomainStatus {
    return this.#domain.getStatus();
  }

  describeOperation(opId: string): string {
    return this.#describeOperation(opId);
  }

  async adjudicate(
    opId: string,
    verdict: "confirmed_stopped" | "abandon_with_residuals",
    actor: string,
    note?: string,
  ): Promise<AdjudicationRecord> {
    this.#assertOpen();
    return this.#domain.adjudicate(opId, verdict, actor, note);
  }

  /**
   * Ends the launch Run and releases the domain. A Run the kernel refuses to
   * close (work still unfinished) is left for the next launch's recovery, and
   * the refusal is returned so the caller can say so.
   */
  close(): Error | undefined {
    if (this.#closed) return undefined;
    this.#closed = true;
    let refusal: Error | undefined;
    let disposable = false;
    try {
      const store = this.#domain.getStore();
      for (const runId of [this.#turnRunId, this.#launchRunId]) {
        if (runId && store.getRun(runId)?.status === "running") {
          store.reportRunSucceeded(runId);
        }
      }
      disposable = this.#ephemeral && store.getAllOperations(this.#domain.domainId)
        .every((op) => op.status === "done" && op.result?.status !== "indeterminate");
    } catch (error) {
      refusal = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.#turnRunId = undefined;
      this.#domain.close();
    }
    if (disposable) {
      fs.rmSync(this.domainPath, { recursive: true, force: true });
    }
    return refusal;
  }

  #registerTaskAndLaunchRun(): void {
    const store = this.#domain.getStore();
    if (!store.getTask(this.taskId)) {
      store.saveTask({
        id: this.taskId,
        domainId: this.#domain.domainId,
        name: `session ${this.sessionId}`,
        createdAt: new Date().toISOString(),
        meta: { workspaceRoot: this.workspaceRoot },
      });
    }
    this.#saveRun(this.#launchRunId);
  }

  #saveRun(runId: string): void {
    this.#domain.getStore().saveRun({
      id: runId,
      taskId: this.taskId,
      domainId: this.#domain.domainId,
      owner: this.sessionId,
      status: "running",
      startedAt: new Date().toISOString(),
    });
  }

  #oneOffOpId(kind: string): string {
    return `op-${sanitizeId(this.sessionId)}-${this.#launchToken}-${kind}-${++this.#sequence}`;
  }

  #leaseRootFor(cwd: string): string {
    const resolved = realpathOr(path.resolve(cwd));
    const inside = resolved === this.workspaceRoot
      || resolved.startsWith(`${this.workspaceRoot}${path.sep}`);
    return inside ? this.workspaceRoot : resolved;
  }

  #leaseHolder(resource: string): LeaseHolder | undefined {
    const opId = this.#domain.getResourceOwner(resource)
      ?? this.#domain.getStore().getPersistedResourceLeases(this.#domain.domainId)
        .find((lease) => lease.resourceId === resource)?.operationId;
    if (!opId) return undefined;
    const op = this.#domain.getStore().getOperation(opId);
    return {
      opId,
      name: op?.name ?? "unknown operation",
      indeterminate: op?.result?.status === "indeterminate",
    };
  }

  #describeOperation(opId: string): string {
    const op = this.#domain.getStore().getOperation(opId);
    return op ? `${opId} (${op.name})` : opId;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error(`kernel session ${this.sessionId} is closed`);
    }
  }
}

type LeaseHolder = Readonly<{ opId: string; name: string; indeterminate: boolean }>;

function writeLease(root: string): string {
  return `workspace:write:${root}`;
}

function withQueueNote(result: ProcessRunResult, holder: LeaseHolder): ProcessRunResult {
  const note = `[kernel] queued behind ${holder.opId} (${holder.name}) for the workspace write lease`;
  return { ...result, stderr: result.stderr.length > 0 ? `${note}\n${result.stderr}` : note };
}

function realpathOr(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

export function sanitizeId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized.slice(0, 64) : "session";
}
