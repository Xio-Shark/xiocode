import type { ExtensionHost } from "../extension-host.ts";
import type { SessionUiSink } from "../session-ui.ts";
import { formatTasklistWidget } from "./format.ts";
import { createPlanTool, PLAN_PROMPT_ADDENDUM, PLAN_TOOL_NAME } from "./plan-tool.ts";
import { loadPlanBoard } from "./store.ts";
import { TASKLIST_WIDGET } from "./types.ts";

export type RegisterPlanOptions = Readonly<{
  workspaceRoot: string;
  sink?: SessionUiSink;
}>;

/** Register `plan` tool, prompt addendum, /plan command; restore widget if board exists. */
export async function registerPlanCapability(
  host: ExtensionHost,
  options: RegisterPlanOptions,
): Promise<void> {
  host.registerTool(createPlanTool({
    workspaceRoot: options.workspaceRoot,
    sink: options.sink,
  }));

  host.on("before_agent_start", (_payload, ctx) => {
    const base = ctx?.getSystemPrompt?.() ?? "";
    if (base.includes("## Plan → tasks → implement")) {
      return undefined;
    }
    const next = base.length > 0
      ? `${base}\n\n${PLAN_PROMPT_ADDENDUM}`
      : PLAN_PROMPT_ADDENDUM;
    return { systemPrompt: next };
  });

  host.registerCommand("plan", {
    description: "Show workspace plan board (.claude/plan) and refresh the todo widget.",
    handler: async () => {
      const board = await loadPlanBoard(options.workspaceRoot);
      if (!board) {
        return "no plan yet — agent should call plan action=bootstrap with a goal";
      }
      options.sink?.setWidget?.(TASKLIST_WIDGET, [...formatTasklistWidget(board)]);
      const done = board.tasks.filter((t) => t.status === "done").length;
      options.sink?.setStatus?.("plan", `plan:${done}/${board.tasks.length}`);
      return [
        board.title,
        board.goal,
        `progress ${done}/${board.tasks.length}`,
        `prd: ${board.prd_path}`,
        `implement: ${board.implement_path}`,
        ...board.tasks.map((t) => `[${t.status}] ${t.id}: ${t.title}`),
      ].join("\n");
    },
  });

  const existing = await loadPlanBoard(options.workspaceRoot);
  if (existing) {
    options.sink?.setWidget?.(TASKLIST_WIDGET, [...formatTasklistWidget(existing)]);
    const done = existing.tasks.filter((t) => t.status === "done").length;
    options.sink?.setStatus?.("plan", `plan:${done}/${existing.tasks.length}`);
  }
}

export { PLAN_TOOL_NAME, PLAN_PROMPT_ADDENDUM };
