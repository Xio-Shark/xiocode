import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  checkpointPreparedWrites,
  prepareWorkspaceWrites,
  publishPreparedWrites,
  rollbackPreparedWrites,
  stagePreparedWrites,
  type PreparedWorkspaceWrite,
} from "./mutation-transaction.ts";

export type WorkspaceMutationWrite = Readonly<{
  relativePath: string;
  content: string;
}>;

export type WorkspaceMutationPhase =
  | "validate"
  | "stage"
  | "checkpoint"
  | "publish"
  | "rollback"
  | "committed";

export type WorkspaceMutationStatus =
  | "committed"
  | "rejected"
  | "rolled_back"
  | "rollback_failed";

export type WorkspaceMutationFileReceipt = Readonly<{
  relative_path: string;
  target_path?: string;
  existed?: boolean;
  backup_path?: string;
}>;

export type WorkspaceMutationReceipt = Readonly<{
  schema_version: "xio-workspace-mutation.v1";
  transaction_id: string;
  workspace_root: string;
  status: WorkspaceMutationStatus;
  phase: WorkspaceMutationPhase;
  created_at: string;
  completed_at: string;
  files: readonly WorkspaceMutationFileReceipt[];
  error?: string;
  rollback_errors?: readonly string[];
}>;

export type WorkspaceMutationHooks = Readonly<{
  /** Deterministic fault-injection seam; production callers normally omit it. */
  beforePublish?: (input: Readonly<{
    index: number;
    relativePath: string;
    targetPath: string;
  }>) => Promise<void> | void;
}>;

export type WorkspaceMutationServiceOptions = Readonly<{
  workspaceRoot: string;
  now?: () => number;
  randomId?: () => string;
  hooks?: WorkspaceMutationHooks;
}>;

export class WorkspaceMutationError extends Error {
  readonly receipt: WorkspaceMutationReceipt;

  constructor(message: string, receipt: WorkspaceMutationReceipt, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkspaceMutationError";
    this.receipt = receipt;
  }
}

export function createRejectedWorkspaceMutationReceipt(input: Readonly<{
  workspaceRoot: string;
  relativePaths: readonly string[];
  reason: string;
  now?: () => number;
  randomId?: () => string;
}>): WorkspaceMutationReceipt {
  const now = input.now ?? Date.now;
  const stamp = now();
  const randomId = input.randomId ?? randomUUID;
  return {
    schema_version: "xio-workspace-mutation.v1",
    transaction_id: `wm-${stamp}-${sanitizeId(randomId())}`,
    workspace_root: path.resolve(input.workspaceRoot),
    status: "rejected",
    phase: "validate",
    created_at: new Date(stamp).toISOString(),
    completed_at: new Date(now()).toISOString(),
    files: input.relativePaths.map((relativePath) => ({ relative_path: relativePath })),
    error: input.reason,
  };
}

/**
 * Single owner for staged, rollback-capable workspace batch writes.
 * Callers retain product policy (allowlists/confirmation); this service owns
 * canonical containment and filesystem transaction mechanics.
 */
export class WorkspaceMutationService {
  readonly #workspaceRoot: string;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #hooks?: WorkspaceMutationHooks;

  constructor(options: WorkspaceMutationServiceOptions) {
    this.#workspaceRoot = path.resolve(options.workspaceRoot);
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? randomUUID;
    this.#hooks = options.hooks;
  }

  async writeBatch(writes: readonly WorkspaceMutationWrite[]): Promise<WorkspaceMutationReceipt> {
    const stamp = this.#now();
    const createdAt = new Date(stamp).toISOString();
    const transactionId = `wm-${stamp}-${sanitizeId(this.#randomId())}`;
    let canonicalRoot = this.#workspaceRoot;
    let phase: WorkspaceMutationPhase = "validate";
    let prepared: PreparedWorkspaceWrite[] = [];
    const createdDirectories: string[] = [];

    try {
      canonicalRoot = await realpath(this.#workspaceRoot);
      prepared = await prepareWorkspaceWrites({
        lexicalRoot: this.#workspaceRoot,
        canonicalRoot,
        writes,
        stamp,
        transactionId,
      });

      phase = "stage";
      await stagePreparedWrites(prepared, createdDirectories);

      phase = "checkpoint";
      await checkpointPreparedWrites(prepared);

      phase = "publish";
      await publishPreparedWrites(prepared, this.#hooks?.beforePublish);

      const completedAt = new Date(this.#now()).toISOString();
      return makeReceipt({
        transactionId,
        workspaceRoot: canonicalRoot,
        status: "committed",
        phase: "committed",
        createdAt,
        completedAt,
        files: prepared,
      });
    } catch (error) {
      throw await buildMutationFailure({
        error,
        phase,
        transactionId,
        workspaceRoot: canonicalRoot,
        createdAt,
        completedAt: new Date(this.#now()).toISOString(),
        prepared,
        writes,
        createdDirectories,
      });
    }
  }
}

async function buildMutationFailure(input: Readonly<{
  error: unknown;
  phase: WorkspaceMutationPhase;
  transactionId: string;
  workspaceRoot: string;
  createdAt: string;
  completedAt: string;
  prepared: readonly PreparedWorkspaceWrite[];
  writes: readonly WorkspaceMutationWrite[];
  createdDirectories: readonly string[];
}>): Promise<WorkspaceMutationError> {
  if (input.phase === "validate") {
    const receipt = makeReceipt({
      transactionId: input.transactionId,
      workspaceRoot: input.workspaceRoot,
      status: "rejected",
      phase: input.phase,
      createdAt: input.createdAt,
      completedAt: input.completedAt,
      files: input.prepared.length > 0 ? input.prepared : input.writes,
      error: errorMessage(input.error),
    });
    return new WorkspaceMutationError(
      `workspace mutation rejected: ${errorMessage(input.error)}`,
      receipt,
      input.error,
    );
  }

  const rollbackErrors = await rollbackPreparedWrites(
    input.prepared,
    input.createdDirectories,
  );
  const status = rollbackErrors.length > 0 ? "rollback_failed" : "rolled_back";
  const receipt = makeReceipt({
    transactionId: input.transactionId,
    workspaceRoot: input.workspaceRoot,
    status,
    phase: input.phase,
    createdAt: input.createdAt,
    completedAt: input.completedAt,
    files: input.prepared,
    error: errorMessage(input.error),
    rollbackErrors,
  });
  const suffix = rollbackErrors.length > 0
    ? `; rollback failed: ${rollbackErrors.join("; ")}`
    : "; batch rolled back";
  return new WorkspaceMutationError(
    `workspace mutation ${input.phase} failed: ${errorMessage(input.error)}${suffix}`,
    receipt,
    input.error,
  );
}

function makeReceipt(input: Readonly<{
  transactionId: string;
  workspaceRoot: string;
  status: WorkspaceMutationStatus;
  phase: WorkspaceMutationPhase;
  createdAt: string;
  completedAt: string;
  files: readonly PreparedWorkspaceWrite[] | readonly WorkspaceMutationWrite[];
  error?: string;
  rollbackErrors?: readonly string[];
}>): WorkspaceMutationReceipt {
  return {
    schema_version: "xio-workspace-mutation.v1",
    transaction_id: input.transactionId,
    workspace_root: input.workspaceRoot,
    status: input.status,
    phase: input.phase,
    created_at: input.createdAt,
    completed_at: input.completedAt,
    files: input.files.map((file) => {
      if ("targetPath" in file) {
        return {
          relative_path: file.relativePath,
          target_path: file.targetPath,
          existed: file.existed,
          ...(file.backupPath ? { backup_path: file.backupPath } : {}),
        };
      }
      return { relative_path: file.relativePath };
    }),
    ...(input.error ? { error: input.error } : {}),
    ...(input.rollbackErrors && input.rollbackErrors.length > 0
      ? { rollback_errors: [...input.rollbackErrors] }
      : {}),
  };
}

function sanitizeId(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized || "transaction";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
