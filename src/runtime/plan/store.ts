import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  IMPLEMENT_MD,
  LEGACY_PLAN_DIR,
  PLAN_DIR,
  PRD_MD,
  TASKS_CSV,
  TASKS_JSON,
  type PlanBoard,
  type PlanTask,
  type PlanTaskStatus,
} from "./types.ts";

export type PlanPaths = Readonly<{
  root: string;
  prd: string;
  implement: string;
  tasksJson: string;
  tasksCsv: string;
}>;

export function planPaths(workspaceRoot: string, dir: string = PLAN_DIR): PlanPaths {
  const root = path.join(path.resolve(workspaceRoot), dir);
  return {
    root,
    prd: path.join(root, PRD_MD),
    implement: path.join(root, IMPLEMENT_MD),
    tasksJson: path.join(root, TASKS_JSON),
    tasksCsv: path.join(root, TASKS_CSV),
  };
}

/**
 * Load plan board from `.claude/plan` (canonical).
 * Falls back once to legacy `.xiocode/plan` so existing boards still open.
 */
export async function loadPlanBoard(workspaceRoot: string): Promise<PlanBoard | undefined> {
  const primary = await readBoardFile(planPaths(workspaceRoot, PLAN_DIR).tasksJson);
  if (primary) {
    return primary;
  }
  return readBoardFile(planPaths(workspaceRoot, LEGACY_PLAN_DIR).tasksJson);
}

async function readBoardFile(tasksJson: string): Promise<PlanBoard | undefined> {
  try {
    const raw = await readFile(tasksJson, "utf8");
    return parsePlanBoard(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function savePlanBoard(
  workspaceRoot: string,
  board: PlanBoard,
): Promise<PlanBoard> {
  const paths = planPaths(workspaceRoot);
  await mkdir(paths.root, { recursive: true });
  const next: PlanBoard = {
    ...board,
    updated_at: new Date().toISOString(),
    prd_path: path.relative(path.resolve(workspaceRoot), paths.prd) || paths.prd,
    implement_path: path.relative(path.resolve(workspaceRoot), paths.implement) || paths.implement,
  };
  await writeFile(paths.tasksJson, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export async function writePlanDocs(
  workspaceRoot: string,
  input: Readonly<{ prd?: string; implement?: string }>,
): Promise<void> {
  const paths = planPaths(workspaceRoot);
  await mkdir(paths.root, { recursive: true });
  if (input.prd !== undefined) {
    await writeFile(paths.prd, ensureTrailingNewline(input.prd), "utf8");
  }
  if (input.implement !== undefined) {
    await writeFile(paths.implement, ensureTrailingNewline(input.implement), "utf8");
  }
}

export async function exportTasksCsv(workspaceRoot: string, board: PlanBoard): Promise<string> {
  const paths = planPaths(workspaceRoot);
  await mkdir(paths.root, { recursive: true });
  const lines = [
    "id,status,title,note",
    ...board.tasks.map((task) =>
      [
        csvEscape(task.id),
        csvEscape(task.status),
        csvEscape(task.title),
        csvEscape(task.note ?? ""),
      ].join(",")
    ),
  ];
  const body = `${lines.join("\n")}\n`;
  await writeFile(paths.tasksCsv, body, "utf8");
  return path.relative(path.resolve(workspaceRoot), paths.tasksCsv) || paths.tasksCsv;
}

export function createEmptyBoard(input: Readonly<{
  title: string;
  goal: string;
  tasks?: readonly PlanTask[];
}>): PlanBoard {
  const now = new Date().toISOString();
  return {
    schema_version: "xio-plan.v1",
    title: input.title.trim() || "Untitled plan",
    goal: input.goal.trim(),
    created_at: now,
    updated_at: now,
    prd_path: `${PLAN_DIR}/${PRD_MD}`,
    implement_path: `${PLAN_DIR}/${IMPLEMENT_MD}`,
    tasks: input.tasks ? normalizeTasks(input.tasks) : [],
  };
}

export function defaultPrdMarkdown(input: Readonly<{ title: string; goal: string }>): string {
  return [
    `# ${input.title.trim() || "PRD"}`,
    "",
    "## 目标",
    input.goal.trim() || "（待补充）",
    "",
    "## 范围",
    "- 必须：",
    "- 不做：",
    "",
    "## 验收",
    "- [ ] ",
    "",
    "## 风险 / 假设",
    "- ",
    "",
  ].join("\n");
}

export function defaultImplementMarkdown(input: Readonly<{ title: string }>): string {
  return [
    `# Implement — ${input.title.trim() || "plan"}`,
    "",
    "## 方案摘要",
    "",
    "## 触达文件 / 模块",
    "",
    "## 步骤",
    "1. ",
    "",
    "## 验证",
    "- ",
    "",
  ].join("\n");
}

export function normalizeTasks(tasks: readonly PlanTask[]): PlanTask[] {
  const used = new Set<string>();
  return tasks.map((task, index) => {
    let id = (task.id?.trim() || `t${index + 1}`).replace(/\s+/g, "-");
    if (used.has(id)) {
      id = `${id}-${index + 1}`;
    }
    used.add(id);
    return {
      id,
      title: task.title.trim() || `Task ${index + 1}`,
      status: parseStatus(task.status) ?? "pending",
      ...(task.note?.trim() ? { note: task.note.trim() } : {}),
    };
  });
}

export function parseStatus(value: unknown): PlanTaskStatus | undefined {
  if (value === "pending" || value === "in_progress" || value === "done") return value;
  if (value === "todo") return "pending";
  if (value === "doing" || value === "wip") return "in_progress";
  if (value === "complete" || value === "completed" || value === "x") return "done";
  return undefined;
}

export function parsePlanBoard(value: unknown): PlanBoard {
  const record = asRecord(value);
  if (!record) throw new Error("tasks.json must be an object");
  const tasksRaw = Array.isArray(record.tasks) ? record.tasks : [];
  const tasks = normalizeTasks(tasksRaw.map((item, index) => {
    const t = asRecord(item) ?? {};
    return {
      id: typeof t.id === "string" ? t.id : `t${index + 1}`,
      title: typeof t.title === "string" ? t.title : String(t.title ?? `Task ${index + 1}`),
      status: (parseStatus(t.status) ?? "pending") as PlanTaskStatus,
      note: typeof t.note === "string" ? t.note : undefined,
    };
  }));
  const title = typeof record.title === "string" ? record.title : "Untitled plan";
  const goal = typeof record.goal === "string" ? record.goal : "";
  const created = typeof record.created_at === "string" ? record.created_at : new Date().toISOString();
  const updated = typeof record.updated_at === "string" ? record.updated_at : created;
  return {
    schema_version: "xio-plan.v1",
    title,
    goal,
    created_at: created,
    updated_at: updated,
    prd_path: typeof record.prd_path === "string" ? record.prd_path : `${PLAN_DIR}/${PRD_MD}`,
    implement_path: typeof record.implement_path === "string"
      ? record.implement_path
      : `${PLAN_DIR}/${IMPLEMENT_MD}`,
    tasks,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
