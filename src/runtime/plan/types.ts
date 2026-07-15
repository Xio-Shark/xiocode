export type PlanTaskStatus = "pending" | "in_progress" | "done";

export type PlanTask = Readonly<{
  id: string;
  title: string;
  status: PlanTaskStatus;
  note?: string;
}>;

/** Workspace plan board: simple PRD + implement notes + task list. */
export type PlanBoard = Readonly<{
  schema_version: "xio-plan.v1";
  title: string;
  goal: string;
  created_at: string;
  updated_at: string;
  prd_path: string;
  implement_path: string;
  tasks: readonly PlanTask[];
}>;

/** Claude Code project tree — plan board lives under .claude/ (not a parallel .xiocode tree). */
export const PLAN_DIR = ".claude/plan";
/** Pre-alignment path; load only as fallback. */
export const LEGACY_PLAN_DIR = ".xiocode/plan";
export const TASKS_JSON = "tasks.json";
export const PRD_MD = "prd.md";
export const IMPLEMENT_MD = "implement.md";
export const TASKS_CSV = "tasks.csv";
export const TASKLIST_WIDGET = "tasklist";
