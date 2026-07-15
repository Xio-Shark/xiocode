import type { PlanBoard, PlanTask } from "./types.ts";

/** Compact lines for TUI tasklist widget. */
export function formatTasklistWidget(board: PlanBoard): readonly string[] {
  const done = board.tasks.filter((t) => t.status === "done").length;
  const total = board.tasks.length;
  const lines = [
    `📋 ${board.title}  ${done}/${total}`,
    board.goal ? `   ${truncate(board.goal, 72)}` : "   (no goal)",
  ];
  if (board.tasks.length === 0) {
    lines.push("   (no tasks yet)");
    return lines;
  }
  for (const task of board.tasks) {
    lines.push(`   ${statusGlyph(task)} ${task.id} ${truncate(task.title, 56)}`);
  }
  return lines;
}

export function formatPlanSummary(board: PlanBoard): string {
  const done = board.tasks.filter((t) => t.status === "done").length;
  return [
    `plan: ${board.title}`,
    `goal: ${board.goal || "(empty)"}`,
    `progress: ${done}/${board.tasks.length}`,
    `prd: ${board.prd_path}`,
    `implement: ${board.implement_path}`,
    ...board.tasks.map((task) => `- [${statusMarker(task)}] ${task.id}: ${task.title}`),
  ].join("\n");
}

/**
 * Short tool reply for model context — TUI already shows the full board.
 * Avoid dumping the whole task list into every plan tool result.
 */
export function formatPlanAck(
  action: string,
  board: PlanBoard,
  detail?: string,
): string {
  const done = board.tasks.filter((t) => t.status === "done").length;
  const total = board.tasks.length;
  const active = board.tasks.find((t) => t.status === "in_progress");
  const parts = [`plan ${action} ok`, `${done}/${total}`];
  if (active) parts.push(`►${active.id}`);
  if (detail) parts.push(detail);
  return parts.join(" · ");
}

/** Compact list for intentional action=list (still smaller than full summary). */
export function formatPlanListCompact(board: PlanBoard): string {
  const done = board.tasks.filter((t) => t.status === "done").length;
  const header = `plan ${board.title} · ${done}/${board.tasks.length}`;
  if (board.tasks.length === 0) return `${header}\n(no tasks)`;
  const lines = board.tasks.map((task) => `${statusMarker(task)} ${task.id} ${truncate(task.title, 48)}`);
  return [header, ...lines].join("\n");
}

function statusGlyph(task: PlanTask): string {
  if (task.status === "done") return "✓";
  if (task.status === "in_progress") return "►";
  return "○";
}

function statusMarker(task: PlanTask): string {
  if (task.status === "done") return "x";
  if (task.status === "in_progress") return "-";
  return " ";
}

function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}
