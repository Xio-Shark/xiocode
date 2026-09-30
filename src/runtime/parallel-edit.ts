/**
 * `parallel_edit`: several agents change the same repository at the same time.
 *
 * Each task gets its own kernel workspace transaction: a fork of the
 * workspace where one worker agent edits files. When a worker finishes, its
 * transaction is committed. The kernel applies the fork's changes only if
 * nothing the worker read or wrote was changed meanwhile — by a transaction
 * that committed first, or by a write straight to the workspace — and reports
 * the conflicting paths otherwise (optimistic concurrency, ARCHITECTURE §3.9).
 *
 * Workers get file tools only (read / grep / glob / write / edit), confined to
 * their fork by the path policy. No shell: a worker host has no permission
 * gate, and nothing a worker does reaches the workspace except through commit.
 */

import { ResourceConflictError, type CommitResult, type TransactionConflict, type WriteEntry } from "@xioflow/kernel";

import { runAgentLoop } from "./agent-loop.ts";
import { defineTool } from "./define-tool.ts";
import { ExtensionHost } from "./extension-host.ts";
import type { KernelSession } from "./process/index.ts";
import { createBuiltinTools } from "./tools/builtin.ts";
import type { LlmClient, ModelInfo, ToolDefinition } from "./types.ts";
import { WorkspacePathPolicy } from "./workspace-path-policy.ts";

export type ParallelTask = Readonly<{ name: string; instruction: string }>;

export type WorkerOutcome = Readonly<{ success: boolean; cancelled?: boolean; summary: string }>;

export type RunWorker = (input: Readonly<{
  task: ParallelTask;
  forkRoot: string;
  signal?: AbortSignal;
}>) => Promise<WorkerOutcome>;

export type TaskReport = Readonly<{
  name: string;
  status: "committed" | "conflict" | "failed" | "cancelled";
  summary: string;
  writeSet: readonly WriteEntry[];
  conflicts: readonly TransactionConflict[];
  /** Other tasks this one lost to (their tx ids mapped to names). */
  lostTo: readonly string[];
}>;

type TransactionPort = Pick<KernelSession, "beginTransaction" | "commitTransaction" | "abortTransaction">;

export const MAX_PARALLEL_TASKS = 4;
const COMMIT_LEASE_WAIT_MS = 60_000;
const COMMIT_LEASE_POLL_MS = 250;

/**
 * Forks one transaction per task, runs the workers concurrently and commits
 * each as soon as its worker is done (first finished, first applied). A
 * failed or cancelled worker's transaction is aborted, as is one that
 * conflicts; nothing is retried behind the caller's back.
 */
export async function runParallelEdit(
  tasks: readonly ParallelTask[],
  kernel: TransactionPort,
  runWorker: RunWorker,
  signal?: AbortSignal,
): Promise<readonly TaskReport[]> {
  // Forks are taken one after another: each is a kernel snapshot of the workspace.
  const opened: Readonly<{ task: ParallelTask; txId: string; forkRoot: string; baseSnapshotId: string }>[] = [];
  try {
    for (const task of tasks) opened.push({ task, ...(await kernel.beginTransaction(task.name)) });
  } catch (error) {
    await Promise.all(opened.map((tx) => kernel.abortTransaction(tx.txId, tx.baseSnapshotId, "setup failed")));
    throw error;
  }
  const names = new Map(opened.map((tx) => [tx.txId, tx.task.name]));
  const reports = await Promise.all(opened.map(async (tx): Promise<TaskReport> => {
    let outcome: WorkerOutcome;
    try {
      outcome = await runWorker({ task: tx.task, forkRoot: tx.forkRoot, ...(signal ? { signal } : {}) });
    } catch (error) {
      outcome = { success: false, summary: `worker failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const base = { name: tx.task.name, summary: outcome.summary, conflicts: [], lostTo: [] };
    if (!outcome.success || outcome.cancelled || signal?.aborted) {
      await kernel.abortTransaction(tx.txId, tx.baseSnapshotId, outcome.cancelled ? "cancelled" : "worker failed");
      return { ...base, status: outcome.cancelled || signal?.aborted ? "cancelled" : "failed", writeSet: [] };
    }
    const result = await commitWhenLeaseFree(kernel, tx.txId, tx.baseSnapshotId);
    if (result.status === "committed") return { ...base, status: "committed", writeSet: result.writeSet };
    await kernel.abortTransaction(tx.txId, tx.baseSnapshotId, "conflict");
    const lostTo = [...new Set(result.conflicts.flatMap((c) => (c.otherTxId ? [names.get(c.otherTxId) ?? c.otherTxId] : [])))];
    return { ...base, status: "conflict", writeSet: result.writeSet, conflicts: result.conflicts, lostTo };
  }));
  return reports;
}

/** Commit takes the workspace write lease; a command holding it right now is waited out (bounded). */
async function commitWhenLeaseFree(kernel: TransactionPort, txId: string, baseSnapshotId: string): Promise<CommitResult> {
  const deadline = Date.now() + COMMIT_LEASE_WAIT_MS;
  for (;;) {
    try {
      return await kernel.commitTransaction(txId, baseSnapshotId);
    } catch (error) {
      if (!(error instanceof ResourceConflictError) || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, COMMIT_LEASE_POLL_MS));
    }
  }
}

export function formatParallelEditReport(reports: readonly TaskReport[]): string {
  const lines = reports.map((report) => {
    const files = report.writeSet.map((entry) => `${entry.status} ${entry.path}`).join(", ") || "no file changes";
    switch (report.status) {
      case "committed":
        return `- ${report.name}: applied (${files})\n  ${indent(report.summary)}`;
      case "conflict": {
        const why = report.conflicts.map((c) => `${c.path} (${describeConflict(c)})`).join("; ");
        const against = report.lostTo.length > 0 ? ` after ${report.lostTo.join(", ")} was applied` : "";
        return `- ${report.name}: NOT applied — conflict${against}: ${why}. Its fork was discarded; `
          + "redo it against the current workspace if it is still needed.";
      }
      case "cancelled":
        return `- ${report.name}: cancelled; nothing applied.`;
      case "failed":
        return `- ${report.name}: worker failed; nothing applied. ${report.summary}`;
    }
  });
  const applied = reports.filter((r) => r.status === "committed").length;
  return [`parallel_edit: ${applied}/${reports.length} task(s) applied to the workspace.`, ...lines].join("\n");
}

function describeConflict(conflict: TransactionConflict): string {
  switch (conflict.kind) {
    case "write_write": return "both changed it";
    case "read_write": return "changed after this task read it";
    case "external_write": return "changed in the workspace outside the transaction";
  }
}

function indent(text: string): string {
  const trimmed = text.trim();
  return (trimmed.length > 600 ? `${trimmed.slice(0, 599)}…` : trimmed).replaceAll("\n", "\n  ");
}

const WORKER_SYSTEM_PROMPT = [
  "You are a coding worker for XioCode, one of several running in parallel.",
  "You work in your own isolated copy of the repository; other workers handle other tasks at the same time.",
  "- Do exactly your assigned task. Touch only the files it needs: a file another worker also changes",
  "  makes one of you conflict, and the conflicting change is discarded.",
  "- Tools: read, grep, glob, write, edit. There is no shell: do not try to run, build or test anything.",
  "- Read a file before editing it. Keep changes minimal and in the style of the surrounding code.",
  "- Finish with 1–3 sentences: what you changed and anything left undone.",
].join("\n");

const WORKER_TOOLS = new Set(["read", "grep", "glob", "write", "edit"]);

/** A worker agent on a fresh host whose file tools are rooted in its fork. */
export function createWorkerRunner(options: Readonly<{
  getClient: () => LlmClient;
  getModel: () => ModelInfo;
  getProviderApi: () => string;
  maxTurns?: number;
  onEvent?: (name: string, event: "start" | "end", detail: string) => void;
}>): RunWorker {
  return async ({ task, forkRoot, signal }) => {
    const model = options.getModel();
    const host = new ExtensionHost({ initialModel: model });
    const pathPolicy = await WorkspacePathPolicy.create({ workspaceRoot: forkRoot, cwd: forkRoot });
    for (const tool of createBuiltinTools({ cwd: forkRoot, workspaceRoot: forkRoot, pathPolicy, contextId: `parallel-${task.name}` })) {
      if (WORKER_TOOLS.has(tool.name)) host.registerTool(tool);
    }
    options.onEvent?.(task.name, "start", task.instruction);
    const result = await runAgentLoop(task.instruction, {
      host,
      client: options.getClient(),
      model: model.id,
      providerApi: options.getProviderApi(),
      providerName: model.provider,
      systemPrompt: WORKER_SYSTEM_PROMPT,
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      parallelToolCalls: true,
      ...(signal ? { signal } : {}),
    });
    const outcome = {
      success: result.success,
      ...(result.cancelled ? { cancelled: true } : {}),
      summary: result.finalText || (result.success ? "(no summary)" : "worker stopped without finishing"),
    };
    options.onEvent?.(task.name, "end", outcome.cancelled ? "cancelled" : outcome.success ? "done" : "failed");
    return outcome;
  };
}

export function createParallelEditTool(options: Readonly<{
  getKernel: () => KernelSession | undefined;
  runWorker: RunWorker;
}>): ToolDefinition {
  return defineTool({
    name: "parallel_edit",
    label: "Parallel edit",
    description: [
      `Split independent code changes across 2–${MAX_PARALLEL_TASKS} worker agents that edit the repository at the same time,`,
      "each in its own kernel transaction (an isolated fork). A worker's changes are applied when it finishes,",
      "unless a file it read or wrote was changed meanwhile: then it is reported as a conflict and not applied.",
      "Use it for tasks that touch different files; workers can only read and edit files (no shell).",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 2,
          maxItems: MAX_PARALLEL_TASKS,
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Short unique label, e.g. 'rename-config'." },
              instruction: { type: "string", description: "Complete, self-contained instruction for the worker." },
            },
            required: ["name", "instruction"],
          },
        },
      },
      required: ["tasks"],
    },
    async execute(_id, params, ctx) {
      const kernel = options.getKernel();
      if (!kernel) return errorResult("parallel_edit needs the kernel session, which is not available in this session.");
      if (kernel.confinement.enabled) {
        return errorResult("parallel_edit is unavailable while write confinement is on: workers edit forks outside the workspace. Run /confine off first.");
      }
      const tasks = parseTasks(params.tasks);
      if (typeof tasks === "string") return errorResult(tasks);
      const reports = await runParallelEdit(tasks, kernel, options.runWorker, ctx?.signal);
      return {
        content: [{ type: "text", text: formatParallelEditReport(reports) }],
        details: { reports },
        isError: reports.every((report) => report.status !== "committed"),
      };
    },
  });
}

function parseTasks(raw: unknown): readonly ParallelTask[] | string {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_PARALLEL_TASKS) {
    return `parallel_edit: tasks must be an array of 2–${MAX_PARALLEL_TASKS} items`;
  }
  const tasks = raw.map((item) => ({
    name: typeof item?.name === "string" ? item.name.trim() : "",
    instruction: typeof item?.instruction === "string" ? item.instruction.trim() : "",
  }));
  if (tasks.some((task) => task.name.length === 0 || task.instruction.length === 0)) {
    return "parallel_edit: every task needs a non-empty name and instruction";
  }
  if (new Set(tasks.map((task) => task.name)).size !== tasks.length) return "parallel_edit: task names must be unique";
  return tasks;
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
