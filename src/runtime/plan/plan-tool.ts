import { defineTool } from "../define-tool.ts";
import { Type } from "../schema.ts";
import path from "node:path";

import type { SessionUiSink } from "../session-ui.ts";
import type { ToolDefinition } from "../types.ts";
import { formatPlanAck, formatPlanListCompact, formatTasklistWidget } from "./format.ts";
import {
  formatParallelPlanHandoff,
  validateParallelPlan,
  writeParallelPlan,
  type ParallelPlanV1,
} from "./parallel-plan.ts";
import {
  createEmptyBoard,
  defaultImplementMarkdown,
  defaultPrdMarkdown,
  exportTasksCsv,
  loadPlanBoard,
  normalizeTasks,
  parseStatus,
  planPaths,
  savePlanBoard,
  writePlanDocs,
} from "./store.ts";
import { TASKLIST_WIDGET, type PlanBoard, type PlanTask, type PlanTaskStatus } from "./types.ts";

export const PLAN_TOOL_NAME = "plan";

export const PLAN_PROMPT_ADDENDUM = [
  "## Plan → tasks → implement (XioCode)",
  "For non-trivial multi-step work, use the `plan` tool **sparingly** before heavy edits:",
  "1. One `bootstrap` with goal (+ optional title/tasks) → PRD + implement under `.claude/plan/`.",
  "2. Optional `docs` once if PRD/implement need real content; keep PRD short.",
  "3. Prefer tasks in bootstrap, or one `set_tasks` with a **small** concrete list.",
  "4. Status updates: mark `in_progress` when starting a slice, `done` when that slice finishes.",
  "   Batch when possible (finish several items, then a few updates). Do **not** call plan after every read/grep/edit.",
  "5. Optional `export_csv`. Skip plan for trivial one-shot questions. Only this board.",
  "6. Ultra + multi-deliverable + Trellis: prefer `parallel_draft` → `.claude/plan/parallel-plan.json` + Trellis handoff (never auto-dispatch).",
  "Tool replies are short acks; the TUI todo widget is the live board — avoid action=list unless you need ids.",
].join("\n");

export type CreatePlanToolOptions = Readonly<{
  workspaceRoot: string;
  sink?: SessionUiSink;
}>;

export function createPlanTool(options: CreatePlanToolOptions): ToolDefinition {
  const publish = async (board: PlanBoard) => {
    options.sink?.setWidget?.(TASKLIST_WIDGET, [...formatTasklistWidget(board)]);
    options.sink?.setStatus?.(
      "plan",
      `plan:${board.tasks.filter((t) => t.status === "done").length}/${board.tasks.length}`,
    );
  };

  return defineTool({
    name: PLAN_TOOL_NAME,
    label: "Plan",
    description:
      "Create/update a simple workspace plan: PRD + implement notes + tasks.json. "
      + "Drives the TUI todo list. Actions: bootstrap, docs, set_tasks, update, list, export_csv.",
    promptSnippet: "PRD/implement docs + task board for multi-step work",
    parameters: Type.Object({
      action: Type.String({
        description: "bootstrap | docs | set_tasks | update | list | export_csv | parallel_draft",
      }),
      title: Type.String({ description: "Plan title (bootstrap)." }),
      goal: Type.String({ description: "User need / goal in one short paragraph." }),
      prd: Type.String({ description: "Full PRD markdown body (bootstrap/docs)." }),
      implement: Type.String({ description: "Implement notes markdown (bootstrap/docs)." }),
      tasks: Type.Array(
        Type.Object({
          id: Type.String({ description: "Stable task id, e.g. t1." }),
          title: Type.String({ description: "Short task title." }),
          status: Type.String({ description: "pending | in_progress | done" }),
          note: Type.String({ description: "Optional note." }),
        }, { required: ["title"] }),
        { description: "Task list for set_tasks / bootstrap." },
      ),
      id: Type.String({ description: "Task id for update." }),
      status: Type.String({ description: "New status for update: pending|in_progress|done" }),
      note: Type.String({ description: "Optional note on update." }),
      parallel_plan_json: Type.String({
        description:
          "JSON string of parallel-plan.v1 for action=parallel_draft "
          + "(version + children with depends_on/isolation/write_scope).",
      }),
      parent_dir: Type.String({
        description: "Trellis parent task dir hint for handoff command (parallel_draft).",
      }),
    }, { required: ["action"] }),
    async execute(_toolCallId, params) {
      const action = String(params.action ?? "").trim().toLowerCase();
      try {
        if (action === "bootstrap") {
          return await runBootstrap(options.workspaceRoot, params, publish);
        }
        if (action === "docs") {
          return await runDocs(options.workspaceRoot, params, publish);
        }
        if (action === "set_tasks") {
          return await runSetTasks(options.workspaceRoot, params, publish);
        }
        if (action === "update") {
          return await runUpdate(options.workspaceRoot, params, publish);
        }
        if (action === "list") {
          const board = await loadPlanBoard(options.workspaceRoot);
          if (!board) {
            return textResult("no plan board yet — call plan action=bootstrap first");
          }
          await publish(board);
          return textResult(formatPlanListCompact(board));
        }
        if (action === "export_csv") {
          const board = await loadPlanBoard(options.workspaceRoot);
          if (!board) {
            return textResult("no plan board yet", true);
          }
          const csvPath = await exportTasksCsv(options.workspaceRoot, board);
          await publish(board);
          return textResult(formatPlanAck("export_csv", board, csvPath));
        }
        if (action === "parallel_draft") {
          return await runParallelDraft(options.workspaceRoot, params);
        }
        return textResult(
          `unknown plan action: ${action} (use bootstrap|docs|set_tasks|update|list|export_csv|parallel_draft)`,
          true,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`plan error: ${message}`, true);
      }
    },
  });
}

async function runParallelDraft(
  workspaceRoot: string,
  params: Record<string, unknown>,
) {
  let raw: unknown = params.parallel_plan;
  if (raw === undefined && typeof params.parallel_plan_json === "string") {
    try {
      raw = JSON.parse(params.parallel_plan_json);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(`parallel_draft: invalid parallel_plan_json (${message})`, true);
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return textResult(
      "parallel_draft requires parallel_plan_json (parallel-plan.v1 JSON string)",
      true,
    );
  }
  const checked = validateParallelPlan(raw);
  if (!checked.ok) {
    return textResult(`parallel_draft invalid: ${checked.errors.join("; ")}`, true);
  }
  const out = await writeParallelPlan(workspaceRoot, checked.plan as ParallelPlanV1);
  const parentHint = typeof params.parent_dir === "string" && params.parent_dir.trim()
    ? params.parent_dir.trim()
    : (checked.plan.parent?.slug ? `<MM-DD-${checked.plan.parent.slug}>` : "<parent-dir>");
  return textResult(
    [
      `parallel_draft ok → ${path.relative(path.resolve(workspaceRoot), out) || out}`,
      `children: ${checked.plan.children.length}`,
      formatParallelPlanHandoff(parentHint),
    ].join("\n"),
  );
}

async function runBootstrap(
  workspaceRoot: string,
  params: Record<string, unknown>,
  publish: (board: PlanBoard) => Promise<void>,
) {
  const goal = typeof params.goal === "string" ? params.goal.trim() : "";
  if (!goal) {
    return textResult("bootstrap requires goal", true);
  }
  const title = typeof params.title === "string" && params.title.trim()
    ? params.title.trim()
    : truncateTitle(goal);
  const tasks = parseTasksParam(params.tasks);
  const board = createEmptyBoard({ title, goal, tasks });
  const prd = typeof params.prd === "string" && params.prd.trim()
    ? params.prd
    : defaultPrdMarkdown({ title, goal });
  const implement = typeof params.implement === "string" && params.implement.trim()
    ? params.implement
    : defaultImplementMarkdown({ title });
  await writePlanDocs(workspaceRoot, { prd, implement });
  const saved = await savePlanBoard(workspaceRoot, board);
  await publish(saved);
  const paths = planPaths(workspaceRoot);
  return textResult(
    formatPlanAck("bootstrap", saved, `${paths.root}/{prd,implement,tasks.json}`),
  );
}

async function runDocs(
  workspaceRoot: string,
  params: Record<string, unknown>,
  publish: (board: PlanBoard) => Promise<void>,
) {
  const prd = typeof params.prd === "string" ? params.prd : undefined;
  const implement = typeof params.implement === "string" ? params.implement : undefined;
  if (prd === undefined && implement === undefined) {
    return textResult("docs requires prd and/or implement markdown", true);
  }
  await writePlanDocs(workspaceRoot, { prd, implement });
  const board = await loadPlanBoard(workspaceRoot);
  if (board) {
    await publish(board);
    const which = [prd !== undefined ? "prd" : "", implement !== undefined ? "implement" : ""]
      .filter(Boolean)
      .join("+");
    return textResult(formatPlanAck("docs", board, which));
  }
  return textResult(`docs updated${prd !== undefined ? " prd" : ""}${implement !== undefined ? " implement" : ""}`);
}

async function runSetTasks(
  workspaceRoot: string,
  params: Record<string, unknown>,
  publish: (board: PlanBoard) => Promise<void>,
) {
  const existing = await loadPlanBoard(workspaceRoot);
  if (!existing) {
    return textResult("no plan board — bootstrap first", true);
  }
  const tasks = parseTasksParam(params.tasks);
  if (tasks.length === 0) {
    return textResult("set_tasks requires a non-empty tasks array", true);
  }
  const saved = await savePlanBoard(workspaceRoot, {
    ...existing,
    tasks: normalizeTasks(tasks),
  });
  await publish(saved);
  return textResult(formatPlanAck("set_tasks", saved, `${saved.tasks.length} tasks`));
}

async function runUpdate(
  workspaceRoot: string,
  params: Record<string, unknown>,
  publish: (board: PlanBoard) => Promise<void>,
) {
  const existing = await loadPlanBoard(workspaceRoot);
  if (!existing) {
    return textResult("no plan board — bootstrap first", true);
  }
  const id = typeof params.id === "string" ? params.id.trim() : "";
  if (!id) return textResult("update requires id", true);
  const status = parseStatus(params.status);
  if (!status) return textResult("update requires status pending|in_progress|done", true);
  const note = typeof params.note === "string" ? params.note.trim() : undefined;
  let found = false;
  const tasks = existing.tasks.map((task) => {
    if (task.id !== id) return task;
    found = true;
    return {
      ...task,
      status: status as PlanTaskStatus,
      ...(note !== undefined ? { note: note || undefined } : {}),
    };
  });
  if (!found) return textResult(`unknown task id: ${id}`, true);
  // At most one in_progress
  const normalized = enforceSingleInProgress(tasks, id, status);
  const saved = await savePlanBoard(workspaceRoot, { ...existing, tasks: normalized });
  await publish(saved);
  return textResult(formatPlanAck("update", saved, `${id}→${status}`));
}

function enforceSingleInProgress(
  tasks: readonly PlanTask[],
  activeId: string,
  newStatus: PlanTaskStatus,
): PlanTask[] {
  if (newStatus !== "in_progress") return [...tasks];
  return tasks.map((task) => {
    if (task.id === activeId) return task;
    if (task.status === "in_progress") return { ...task, status: "pending" };
    return task;
  });
}

function parseTasksParam(value: unknown): PlanTask[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    return {
      id: typeof record.id === "string" ? record.id : `t${index + 1}`,
      title: typeof record.title === "string" ? record.title : `Task ${index + 1}`,
      status: (parseStatus(record.status) ?? "pending") as PlanTaskStatus,
      note: typeof record.note === "string" ? record.note : undefined,
    };
  });
}

function truncateTitle(goal: string): string {
  const one = goal.replace(/\s+/g, " ").trim();
  if (one.length <= 48) return one;
  return `${one.slice(0, 47)}…`;
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}
