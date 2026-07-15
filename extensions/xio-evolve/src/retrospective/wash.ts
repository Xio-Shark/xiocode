import type {
  BlockerEntry,
  BlockerLog,
  RetrospectiveAction,
  RetrospectiveReport,
} from "./types.ts";

/**
 * Wash raw blocker log into a primary-agent-ready report + optimize actions.
 * Second stage of the post-task pipeline (deterministic "subagent" wash).
 */
export function washRetrospectiveReport(
  log: BlockerLog,
  options: Readonly<{ now?: () => string; llmSummary?: string }> = {},
): RetrospectiveReport {
  const now = options.now?.() ?? new Date().toISOString();
  const actions = deriveActions(log.blockers);
  const title = log.task_success
    ? `Task retrospective ${log.run_id} (completed with friction)`
    : `Task retrospective ${log.run_id} (failed / blocked)`;
  const executive = options.llmSummary?.trim()
    || buildExecutiveSummary(log);
  const markdown = formatMarkdown({ title, executive, log, actions });
  return {
    schema_version: "xio-retrospective.v1",
    run_id: log.run_id,
    created_at: now,
    title,
    executive_summary: executive,
    blockers: log.blockers,
    actions,
    markdown,
    pending_for_main: actions.length > 0 || log.blockers.length > 0,
  };
}

export function formatInjectionContext(report: RetrospectiveReport): string {
  const highMed = report.actions.filter((a) => a.priority === "high" || a.priority === "medium");
  return [
    "## Post-task retrospective (auto)",
    `run: ${report.run_id}`,
    report.executive_summary,
    "",
    "You are the primary agent. Prefer durable XioCode/config fixes over redoing the user task.",
    "High/medium actions may already be queued as ImproveGoal drafts under ~/.xiocode/improve/queue/",
    "(entropy-<action_id>.json). Never auto-merge; user MergeGate only.",
    "",
    "### Blockers",
    ...report.blockers.slice(0, 12).map((b) =>
      `- [${b.kind}] ${b.summary}${b.location ? ` @ ${b.location}` : ""}${b.cause ? ` — ${b.cause}` : ""}`
    ),
    "",
    "### Recommended actions",
    ...report.actions.slice(0, 8).map((a) =>
      `- (${a.priority}/${a.target}) ${a.title}: ${a.detail}`
    ),
    highMed.length > 0
      ? `\nEntropy queue keys: ${highMed.map((a) => a.id).join(", ")}`
      : "",
    "",
    "Full report: run store retrospective-report.md.",
  ].filter((line) => line !== undefined).join("\n");
}

function buildExecutiveSummary(log: BlockerLog): string {
  if (log.blockers.length === 0) {
    return log.task_success
      ? "Task completed with no recorded blockers."
      : "Task ended without structured blockers; check failure_reasons.";
  }
  const top = log.blockers.slice(0, 3).map((b) => b.summary).join("; ");
  return [
    `Observed ${log.blockers.length} blocker(s), ${log.tool_error_count} tool error(s) across ${log.tool_call_count} tool call(s).`,
    `Top: ${top}`,
  ].join(" ");
}

function deriveActions(blockers: readonly BlockerEntry[]): RetrospectiveAction[] {
  const actions: RetrospectiveAction[] = [];
  const kinds = new Set(blockers.map((b) => b.kind));

  if (kinds.has("repeated_tool") || kinds.has("stuck_loop")) {
    actions.push({
      id: "cfg-repeat-turns",
      target: "config",
      title: "Tune tool-loop guards / max_turns",
      detail:
        "Repeated identical tools or stuck loops — verify general.repeat_tool_limit and max_turns; "
        + "tighten plan/update frequency in prompts if plan spam.",
      touchpoints: [
        "general.repeat_tool_limit",
        "general.max_turns",
        "src/runtime/agent-loop.ts",
        "src/runtime/plan/plan-tool.ts",
      ],
      priority: "high",
    });
  }

  if (kinds.has("permission")) {
    actions.push({
      id: "cfg-permission",
      target: "config",
      title: "Review permission mode defaults",
      detail: "Permission denials blocked tools — check strict/auto/full defaults and allow_high_risk policy.",
      touchpoints: ["permissions.allow_high_risk", "src/runtime/permission-mode.ts"],
      priority: "medium",
    });
  }

  if (kinds.has("exit_code") || blockers.some((b) => b.tool === "bash")) {
    actions.push({
      id: "code-bash-ergonomics",
      target: "xiocode",
      title: "Improve bash/error surfacing or default CLI tools",
      detail:
        "Shell failures dominate — ensure ugrep/rg/bfs discovery messages and bash error previews help the model recover faster.",
      touchpoints: [
        "src/runtime/tools/search-backend.ts",
        "src/runtime/tools/builtin.ts",
        "extensions/xio-evolve/src/result-denoiser.ts",
      ],
      priority: "medium",
    });
  }

  if (blockers.some((b) => b.tool === "edit" || /edit failed/i.test(b.summary))) {
    actions.push({
      id: "code-edit",
      target: "xiocode",
      title: "Harden edit tool / prompts for unique matches",
      detail: "Ambiguous or failed edits — improve fuzzy guidance or prompt snippets for smaller unique anchors.",
      touchpoints: ["src/runtime/tools/builtin.ts", "src/runtime/system-prompt.ts"],
      priority: "medium",
    });
  }

  if (kinds.has("timeout")) {
    actions.push({
      id: "cfg-timeouts",
      target: "config",
      title: "Adjust explore/tool timeouts",
      detail: "Timeouts hit — raise explore.timeout_ms or reduce subagent scope via partition_hint.",
      touchpoints: ["explore.timeout_ms", "explore.max_turns"],
      priority: "low",
    });
  }

  if (actions.length === 0 && blockers.length > 0) {
    actions.push({
      id: "workflow-review",
      target: "workflow",
      title: "Review trajectory and prompt addenda",
      detail: "Unclassified friction — inspect blockers.log.json and consider prompt/tool description fixes.",
      touchpoints: ["~/.xiocode/runs", "src/runtime/system-prompt.ts"],
      priority: "low",
    });
  }

  return actions;
}

function formatMarkdown(input: Readonly<{
  title: string;
  executive: string;
  log: BlockerLog;
  actions: readonly RetrospectiveAction[];
}>): string {
  const { title, executive, log, actions } = input;
  return [
    `# ${title}`,
    "",
    `- run_id: \`${log.run_id}\``,
    `- success: ${log.task_success}`,
    `- tool_calls: ${log.tool_call_count}`,
    `- tool_errors: ${log.tool_error_count}`,
    "",
    "## Executive summary",
    executive,
    "",
    "## Failure reasons",
    ...(log.failure_reasons.length > 0
      ? log.failure_reasons.map((r) => `- ${r}`)
      : ["- (none)"]),
    "",
    "## Blockers",
    ...(log.blockers.length > 0
      ? log.blockers.map((b) =>
        [
          `### ${b.id}`,
          `- kind: ${b.kind}`,
          `- summary: ${b.summary}`,
          b.tool ? `- tool: ${b.tool}` : undefined,
          b.location ? `- location: ${b.location}` : undefined,
          b.cause ? `- cause: ${b.cause}` : undefined,
          b.count ? `- count: ${b.count}` : undefined,
          b.evidence ? `- evidence: \`${b.evidence.replace(/`/g, "'")}\`` : undefined,
          "",
        ].filter(Boolean).join("\n")
      )
      : ["_(no blockers)_", ""]),
    "## Recommended optimize actions",
    ...(actions.length > 0
      ? actions.map((a) =>
        [
          `### ${a.id} (${a.priority} / ${a.target})`,
          a.title,
          "",
          a.detail,
          "",
          `Touchpoints: ${a.touchpoints.join(", ")}`,
          "",
        ].join("\n")
      )
      : ["_(none)_", ""]),
  ].join("\n");
}
