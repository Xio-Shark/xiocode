import type { LlmClient } from "../../../../src/runtime/types.ts";
import type { BlockerLog, RetrospectiveAction, RetrospectiveReport } from "./types.ts";
import { washRetrospectiveReport } from "./wash.ts";
import type { NormsProposedFile } from "./norms-write.ts";

export const SESSION_RETROSPECTIVE_SCHEMA = "xio-session-retrospective.v1" as const;

export type SessionRetrospectiveReport = Readonly<{
  schema_version: typeof SESSION_RETROSPECTIVE_SCHEMA;
  run_id: string;
  created_at: string;
  title: string;
  /** Rough conversation / task content summary. */
  content_summary: string;
  executive_summary: string;
  blockers: RetrospectiveReport["blockers"];
  actions: readonly RetrospectiveAction[];
  markdown: string;
  pending_for_main: boolean;
  /** How the report was produced. */
  source: "llm_subagent" | "deterministic_fallback";
  /** Optional norms file proposals (drafts only until confirm). */
  norms_proposals?: readonly NormsProposedFile[];
}>;

export type SessionSubagentInput = Readonly<{
  runId: string;
  log: BlockerLog;
  draft: RetrospectiveReport;
  /** Truncated transcript / events text for the model. */
  evidenceText?: string;
  model?: string;
  client?: LlmClient;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type SessionSubagentResult = Readonly<{
  report: SessionRetrospectiveReport;
  timedOut?: boolean;
  error?: string;
}>;

const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * Session-end retrospective subagent: short LLM polish over deterministic wash.
 * No workspace mutate tools — text-only complete(). Fail-closed to deterministic wash.
 */
export async function runSessionRetrospectiveSubagent(
  input: SessionSubagentInput,
): Promise<SessionSubagentResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!input.client || !input.model) {
    return {
      report: toSessionReport(input.draft, "deterministic_fallback"),
      error: "no provider",
    };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const prompt = buildSubagentPrompt(input);
    const completion = await Promise.race([
      input.client.complete(
        {
          model: input.model,
          messages: [
            {
              role: "system",
              content: [
                "You are a read-only session retrospective subagent for XioCode.",
                "Return ONLY compact JSON matching the schema described by the user.",
                "Do not invent file paths outside AGENTS.md, CLAUDE.md, or .trellis/spec/.",
                "Prefer durable config/xiocode/workflow actions; norms proposals are drafts only.",
              ].join(" "),
            },
            { role: "user", content: prompt },
          ],
          tools: [],
          parallelToolCalls: false,
        },
        { signal: controller.signal },
      ),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error("session retrospective subagent timed out or aborted"));
        }, { once: true });
      }),
    ]);

    const parsed = parseSubagentJson(completion.content);
    if (!parsed) {
      return {
        report: toSessionReport(input.draft, "deterministic_fallback", {
          contentSummary: input.draft.executive_summary,
        }),
        error: "unparseable LLM output",
      };
    }

    const actions = mergeActions(input.draft.actions, parsed.actions);
    const contentSummary = parsed.content_summary?.trim() || input.draft.executive_summary;
    const executive = parsed.executive_summary?.trim() || input.draft.executive_summary;
    const norms = Array.isArray(parsed.norms_proposals)
      ? parsed.norms_proposals.filter(isNormsProposal).slice(0, 8)
      : undefined;
    const markdown = formatSessionMarkdown({
      title: parsed.title?.trim() || input.draft.title,
      contentSummary,
      executive,
      log: input.log,
      actions,
      source: "llm_subagent",
    });

    return {
      report: {
        schema_version: SESSION_RETROSPECTIVE_SCHEMA,
        run_id: input.runId,
        created_at: new Date().toISOString(),
        title: parsed.title?.trim() || input.draft.title,
        content_summary: contentSummary,
        executive_summary: executive,
        blockers: input.draft.blockers,
        actions,
        markdown,
        pending_for_main: actions.length > 0 || input.draft.blockers.length > 0,
        source: "llm_subagent",
        ...(norms && norms.length > 0 ? { norms_proposals: norms } : {}),
      },
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      report: toSessionReport(input.draft, "deterministic_fallback"),
      timedOut,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

export function toSessionReport(
  draft: RetrospectiveReport,
  source: SessionRetrospectiveReport["source"],
  extras: Readonly<{ contentSummary?: string }> = {},
): SessionRetrospectiveReport {
  const contentSummary = extras.contentSummary ?? draft.executive_summary;
  return {
    schema_version: SESSION_RETROSPECTIVE_SCHEMA,
    run_id: draft.run_id,
    created_at: draft.created_at,
    title: draft.title,
    content_summary: contentSummary,
    executive_summary: draft.executive_summary,
    blockers: draft.blockers,
    actions: draft.actions,
    markdown: formatSessionMarkdown({
      title: draft.title,
      contentSummary,
      executive: draft.executive_summary,
      log: {
        schema_version: "xio-blocker-log.v1",
        run_id: draft.run_id,
        created_at: draft.created_at,
        task_success: true,
        failure_reasons: [],
        blockers: draft.blockers,
        tool_error_count: 0,
        tool_call_count: 0,
      },
      actions: draft.actions,
      source,
    }),
    pending_for_main: draft.pending_for_main,
    source,
  };
}

export function sessionReportFromDeterministic(
  log: BlockerLog,
  options?: Readonly<{ llmSummary?: string }>,
): SessionRetrospectiveReport {
  const draft = washRetrospectiveReport(log, options);
  return toSessionReport(draft, "deterministic_fallback");
}

function buildSubagentPrompt(input: SessionSubagentInput): string {
  return [
    `Run id: ${input.runId}`,
    "",
    "Return JSON keys:",
    '{ "title": string, "content_summary": string, "executive_summary": string,',
    '  "actions": [{"id","target","title","detail","touchpoints","priority"}],',
    '  "norms_proposals": [{"relativePath","content","summary"}] }',
    "target must be one of: config | xiocode | workflow | norms",
    "priority: high | medium | low",
    "",
    "## Deterministic draft",
    input.draft.markdown.slice(0, 12_000),
    "",
    "## Evidence (truncated)",
    (input.evidenceText ?? "").slice(0, 8_000) || "(none)",
  ].join("\n");
}

function parseSubagentJson(text: string): {
  title?: string;
  content_summary?: string;
  executive_summary?: string;
  actions?: RetrospectiveAction[];
  norms_proposals?: NormsProposedFile[];
} | undefined {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as {
      title?: string;
      content_summary?: string;
      executive_summary?: string;
      actions?: RetrospectiveAction[];
      norms_proposals?: NormsProposedFile[];
    };
  } catch {
    return undefined;
  }
}

function mergeActions(
  base: readonly RetrospectiveAction[],
  incoming: RetrospectiveAction[] | undefined,
): RetrospectiveAction[] {
  if (!incoming || incoming.length === 0) return [...base];
  const byId = new Map<string, RetrospectiveAction>();
  for (const action of base) byId.set(action.id, action);
  for (const action of incoming) {
    if (!action?.id || !action.title) continue;
    const target = normalizeTarget(action.target);
    byId.set(action.id, {
      id: action.id,
      target,
      title: String(action.title),
      detail: String(action.detail ?? ""),
      touchpoints: Array.isArray(action.touchpoints)
        ? action.touchpoints.map(String)
        : [],
      priority: action.priority === "high" || action.priority === "medium" || action.priority === "low"
        ? action.priority
        : "medium",
    });
  }
  return [...byId.values()];
}

function normalizeTarget(target: unknown): RetrospectiveAction["target"] {
  if (target === "config" || target === "xiocode" || target === "workflow" || target === "norms") {
    return target;
  }
  return "unknown";
}

function isNormsProposal(value: unknown): value is NormsProposedFile {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.relativePath === "string" && typeof record.content === "string";
}

function formatSessionMarkdown(input: Readonly<{
  title: string;
  contentSummary: string;
  executive: string;
  log: BlockerLog;
  actions: readonly RetrospectiveAction[];
  source: SessionRetrospectiveReport["source"];
}>): string {
  return [
    `# ${input.title}`,
    "",
    `- schema: \`${SESSION_RETROSPECTIVE_SCHEMA}\``,
    `- run_id: \`${input.log.run_id}\``,
    `- source: ${input.source}`,
    "",
    "## Content summary",
    input.contentSummary,
    "",
    "## Executive summary",
    input.executive,
    "",
    "## Blockers",
    ...(input.log.blockers.length > 0
      ? input.log.blockers.map((b) => `- [${b.kind}] ${b.summary}`)
      : ["_(none)_"]),
    "",
    "## Recommended actions",
    ...(input.actions.length > 0
      ? input.actions.map((a) => `- (${a.priority}/${a.target}) ${a.title}: ${a.detail}`)
      : ["_(none)_"]),
  ].join("\n");
}
