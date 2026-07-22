import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { LlmClient } from "../../../../src/runtime/types.ts";
import type { RunStore } from "../run-store.ts";
import type { RunSummary } from "../types.ts";
import { extractBlockerLog, type EventRow, type TrajectorySnapshot } from "./extract.ts";
import {
  applyNormsWrites,
  formatNormsConfirmDetail,
  type NormsProposedFile,
  writePendingNormsOffer,
} from "./norms-write.ts";
import {
  runSessionRetrospectiveSubagent,
  sessionReportFromDeterministic,
  type SessionRetrospectiveReport,
} from "./session-subagent.ts";
import {
  DEFAULT_RETROSPECTIVE_CONFIG,
  type BlockerLog,
  type RetrospectiveConfig,
  type RetrospectiveReport,
} from "./types.ts";
import { formatInjectionContext, washRetrospectiveReport } from "./wash.ts";

export type RetrospectiveRunnerOptions = Readonly<{
  runStore: RunStore;
  config?: Partial<RetrospectiveConfig>;
  /** Optional LLM polish: input washed markdown + log, return executive summary text. */
  summarizeWithLlm?: (input: Readonly<{
    log: BlockerLog;
    draftMarkdown: string;
  }>) => Promise<string | undefined>;
  /** Optional session-end LLM client factory (fail-closed when missing). */
  getSessionClient?: () => Readonly<{ client: LlmClient; model: string }> | undefined;
  improveQueueRoot?: string;
  notify?: (message: string) => void;
  /** Interactive ask for norms confirm; when missing, norms writes defer to pending. */
  ask?: (question: string, detail?: string) => Promise<boolean>;
  /** Workspace root for norms allowlist writes. */
  getWorkspaceRoot?: () => string | undefined;
}>;

export type RetrospectiveResult = Readonly<{
  skipped: boolean;
  reason?: string;
  log?: BlockerLog;
  report?: RetrospectiveReport;
  sessionReport?: SessionRetrospectiveReport;
  paths?: Readonly<{
    logJson: string;
    reportJson: string;
    reportMd: string;
    /** First enqueued goal (compat). */
    improveGoal?: string;
    /** All entropy-keyed improve goals written this run. */
    improveGoals?: readonly string[];
    preflightJson?: string;
    normsRecommendations?: string;
    pendingNorms?: string;
  }>;
}>;

/**
 * After a full task/run finishes: extract blockers → write log → wash report → enqueue / inject.
 * Session-end path writes authoritative session-retrospective.*; agent_end writes preflight only.
 */
export class RetrospectiveRunner {
  readonly #store: RunStore;
  readonly #config: RetrospectiveConfig;
  readonly #summarizeWithLlm?: RetrospectiveRunnerOptions["summarizeWithLlm"];
  readonly #getSessionClient?: RetrospectiveRunnerOptions["getSessionClient"];
  readonly #improveQueueRoot: string;
  readonly #notify?: (message: string) => void;
  readonly #ask?: RetrospectiveRunnerOptions["ask"];
  readonly #getWorkspaceRoot?: RetrospectiveRunnerOptions["getWorkspaceRoot"];
  #pendingInjection: string | undefined;
  #lastRunId: string | undefined;

  constructor(options: RetrospectiveRunnerOptions) {
    this.#store = options.runStore;
    this.#config = { ...DEFAULT_RETROSPECTIVE_CONFIG, ...options.config };
    this.#summarizeWithLlm = options.summarizeWithLlm;
    this.#getSessionClient = options.getSessionClient;
    this.#improveQueueRoot = options.improveQueueRoot
      ?? path.join(os.homedir(), ".xiocode", "improve", "queue");
    this.#notify = options.notify;
    this.#ask = options.ask;
    this.#getWorkspaceRoot = options.getWorkspaceRoot;
  }

  get config(): RetrospectiveConfig {
    return this.#config;
  }

  /** Context string for the next turn_start (cleared when consumed). */
  consumeInjection(): string | undefined {
    const text = this.#pendingInjection;
    this.#pendingInjection = undefined;
    return text;
  }

  peekInjection(): string | undefined {
    return this.#pendingInjection;
  }

  /**
   * agent_end path: deterministic extract + light wash → preflight artifacts only.
   * Does not write authoritative session-retrospective.*.
   */
  async runPreflight(input: Readonly<{
    runId: string;
    summary: RunSummary;
    agentSuccess?: boolean;
    cancelled?: boolean;
  }>): Promise<RetrospectiveResult> {
    if (!this.#config.enabled) {
      return { skipped: true, reason: "disabled" };
    }
    if (input.cancelled) {
      return { skipped: true, reason: "cancelled" };
    }

    this.#lastRunId = input.runId;
    const { log, draft } = await this.#buildLogAndDraft(input.runId, input.summary);
    if (this.#config.skipTrivial && log.tool_call_count < this.#config.minToolCalls && log.blockers.length === 0) {
      return { skipped: true, reason: "trivial" };
    }

    const preflight = {
      ...draft,
      superseded_by: "session" as const,
    };
    const preflightJson = "blockers.preflight.json";
    await this.#store.writeJson(input.runId, preflightJson, log);
    await this.#store.writeJson(input.runId, "retrospective-report.json", preflight);
    await this.#store.writeText(
      input.runId,
      "retrospective-report.md",
      `${preflight.markdown}\n\n---\n_superseded_by: session (authoritative report is session-retrospective.md)_\n`,
    );

    return {
      skipped: false,
      log,
      report: preflight,
      paths: {
        logJson: this.#store.filePath(input.runId, preflightJson),
        reportJson: this.#store.filePath(input.runId, "retrospective-report.json"),
        reportMd: this.#store.filePath(input.runId, "retrospective-report.md"),
        preflightJson: this.#store.filePath(input.runId, preflightJson),
      },
    };
  }

  /**
   * session_end / /retrospect rerun path: optional LLM subagent → authoritative artifacts.
   */
  async runSessionEnd(input: Readonly<{
    runId?: string;
    summary?: RunSummary;
    cancelled?: boolean;
    /** When true, force subagent even if sessionEndSubagent config is false. */
    forceSubagent?: boolean;
    signal?: AbortSignal;
  }> = {}): Promise<RetrospectiveResult> {
    if (!this.#config.enabled) {
      return { skipped: true, reason: "disabled" };
    }
    if (input.cancelled) {
      return { skipped: true, reason: "cancelled" };
    }

    const runId = input.runId ?? this.#lastRunId;
    if (!runId) {
      return { skipped: true, reason: "no_run" };
    }

    const summary = input.summary ?? await this.#readSummary(runId);
    if (!summary) {
      return { skipped: true, reason: "no_summary" };
    }

    const { log, draft } = await this.#buildLogAndDraft(runId, summary);
    if (this.#config.skipTrivial && log.tool_call_count < this.#config.minToolCalls && log.blockers.length === 0) {
      return { skipped: true, reason: "trivial" };
    }

    const wantSubagent = input.forceSubagent === true || this.#config.sessionEndSubagent;
    let sessionReport: SessionRetrospectiveReport;
    if (wantSubagent) {
      const session = this.#getSessionClient?.();
      const evidenceText = await this.#readEvidenceText(runId);
      const sub = await runSessionRetrospectiveSubagent({
        runId,
        log,
        draft,
        evidenceText,
        model: this.#config.model ?? session?.model,
        client: session?.client,
        signal: input.signal,
        timeoutMs: this.#config.sessionEndTimeoutMs,
      });
      sessionReport = sub.report;
      if (sub.error) {
        this.#notify?.(
          `session retrospective fallback (${sub.timedOut ? "timeout" : "error"}): ${sub.error}`,
        );
      }
    } else {
      sessionReport = sessionReportFromDeterministic(log);
    }

    await this.#store.writeJson(runId, "blockers.log.json", log);
    await this.#store.writeJson(runId, "session-retrospective.json", sessionReport);
    await this.#store.writeText(runId, "session-retrospective.md", sessionReport.markdown);

    let normsRecommendations: string | undefined;
    const normsActions = sessionReport.actions.filter((a) => a.target === "norms");
    const proposals = sessionReport.norms_proposals ?? normsActionsToProposals(normsActions);
    if (proposals.length > 0 || normsActions.length > 0) {
      normsRecommendations = [
        "# Norms recommendations (draft)",
        "",
        `run: ${runId}`,
        "",
        ...normsActions.map((a) => `- ${a.title}: ${a.detail}`),
        "",
        ...(proposals.length > 0
          ? ["## Proposed files", ...proposals.map((p) => `- ${p.relativePath}: ${p.summary ?? `${p.content.length} chars`}`)]
          : []),
      ].join("\n");
      await this.#store.writeText(runId, "norms-recommendations.md", `${normsRecommendations}\n`);
    }

    let improveGoalPaths: string[] = [];
    if (this.#config.enqueueImprove && sessionReport.actions.length > 0) {
      improveGoalPaths = await this.#enqueueImproveGoals(sessionReport);
    }

    let pendingNormsPath: string | undefined;
    if (proposals.length > 0) {
      pendingNormsPath = await this.#handleNormsProposals(runId, proposals);
    }

    if (this.#config.autoInject && sessionReport.pending_for_main) {
      this.#pendingInjection = formatInjectionContext({
        schema_version: "xio-retrospective.v1",
        run_id: sessionReport.run_id,
        created_at: sessionReport.created_at,
        title: sessionReport.title,
        executive_summary: sessionReport.executive_summary,
        blockers: sessionReport.blockers,
        actions: sessionReport.actions.filter((a) => a.target !== "norms"),
        markdown: sessionReport.markdown,
        pending_for_main: sessionReport.pending_for_main,
      });
    }

    this.#notify?.(
      `session retrospective: ${log.blockers.length} blocker(s) → ${this.#store.filePath(runId, "session-retrospective.md")}`
        + (improveGoalPaths.length > 0 ? ` (+${improveGoalPaths.length} improve goal(s))` : ""),
    );

    return {
      skipped: false,
      log,
      report: draft,
      sessionReport,
      paths: {
        logJson: this.#store.filePath(runId, "blockers.log.json"),
        reportJson: this.#store.filePath(runId, "session-retrospective.json"),
        reportMd: this.#store.filePath(runId, "session-retrospective.md"),
        ...(improveGoalPaths[0] ? { improveGoal: improveGoalPaths[0] } : {}),
        ...(improveGoalPaths.length > 0 ? { improveGoals: improveGoalPaths } : {}),
        ...(normsRecommendations
          ? { normsRecommendations: this.#store.filePath(runId, "norms-recommendations.md") }
          : {}),
        ...(pendingNormsPath ? { pendingNorms: pendingNormsPath } : {}),
      },
    };
  }

  /** Compat: full finished-task path used by older tests — now session-end authoritative. */
  async runForFinishedTask(input: Readonly<{
    runId: string;
    summary: RunSummary;
    agentSuccess?: boolean;
    cancelled?: boolean;
  }>): Promise<RetrospectiveResult> {
    await this.runPreflight(input);
    return this.runSessionEnd({
      runId: input.runId,
      summary: input.summary,
      cancelled: input.cancelled,
      forceSubagent: this.#config.sessionEndSubagent,
    });
  }

  async #buildLogAndDraft(runId: string, summary: RunSummary): Promise<{
    log: BlockerLog;
    draft: RetrospectiveReport;
  }> {
    const events = await this.#readEvents(runId);
    const trajectory = await this.#readTrajectory(runId);
    const log = extractBlockerLog({
      runId,
      summary,
      events,
      trajectory,
    });
    let llmSummary: string | undefined;
    const draftBase = washRetrospectiveReport(log);
    if (this.#config.useLlm && this.#summarizeWithLlm) {
      try {
        llmSummary = await this.#summarizeWithLlm({ log, draftMarkdown: draftBase.markdown });
      } catch (error) {
        this.#notify?.(
          `retrospective LLM polish failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { log, draft: washRetrospectiveReport(log, { llmSummary }) };
  }

  async #handleNormsProposals(runId: string, proposals: readonly NormsProposedFile[]): Promise<string | undefined> {
    const workspaceRoot = this.#getWorkspaceRoot?.();
    if (!this.#config.normsAutoWrite) {
      return undefined;
    }
    if (!workspaceRoot) {
      this.#notify?.("norms auto-write skipped: no workspace root");
      return undefined;
    }

    if (!this.#ask) {
      const pendingPath = await writePendingNormsOffer({
        schema_version: "xio-pending-norms.v1",
        created_at: new Date().toISOString(),
        run_id: runId,
        workspace_root: workspaceRoot,
        files: proposals,
      });
      this.#notify?.(`norms confirm deferred to next session: ${pendingPath}`);
      return pendingPath;
    }

    const ok = await this.#ask(
      "Apply recommended norms writes to this workspace?",
      formatNormsConfirmDetail(proposals),
    );
    if (!ok) {
      this.#notify?.("norms writes rejected — drafts kept");
      return undefined;
    }
    const result = await applyNormsWrites({ workspaceRoot, files: proposals });
    if (result.rejected.length > 0) {
      this.#notify?.(`norms write rejected: ${result.rejected.join("; ")}`);
      return undefined;
    }
    this.#notify?.(`norms written: ${result.written.join(", ")}`);
    return undefined;
  }

  async #readEvents(runId: string): Promise<EventRow[]> {
    try {
      const raw = await readFile(this.#store.filePath(runId, "events.jsonl"), "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as EventRow;
          } catch {
            return {};
          }
        });
    } catch {
      return [];
    }
  }

  async #readTrajectory(runId: string): Promise<TrajectorySnapshot | undefined> {
    try {
      const raw = await readFile(this.#store.filePath(runId, "trajectory.json"), "utf8");
      return JSON.parse(raw) as TrajectorySnapshot;
    } catch {
      return undefined;
    }
  }

  async #readSummary(runId: string): Promise<RunSummary | undefined> {
    try {
      const raw = await readFile(this.#store.filePath(runId, "summary.json"), "utf8");
      return JSON.parse(raw) as RunSummary;
    } catch {
      return undefined;
    }
  }

  async #readEvidenceText(runId: string): Promise<string> {
    const parts: string[] = [];
    try {
      parts.push(await readFile(this.#store.filePath(runId, "events.jsonl"), "utf8"));
    } catch {
      // ignore
    }
    try {
      parts.push(await readFile(this.#store.filePath(runId, "trajectory.json"), "utf8"));
    } catch {
      // ignore
    }
    return parts.join("\n").slice(0, 16_000);
  }

  /**
   * Enqueue high/medium actions as entropy-keyed goals (stable id = action.id).
   * Norms targets are never enqueued — they use the confirm/write path only.
   */
  async #enqueueImproveGoals(report: SessionRetrospectiveReport | RetrospectiveReport): Promise<string[]> {
    await mkdir(this.#improveQueueRoot, { recursive: true });
    const ranked = [...report.actions]
      .filter((action) => action.target !== "norms")
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
    const selected = ranked
      .filter((action) => action.priority === "high" || action.priority === "medium")
      .slice(0, 3);
    const toWrite = selected.length > 0 ? selected : ranked.slice(0, 1);
    const paths: string[] = [];

    for (const action of toWrite) {
      const entropyKey = action.id;
      const fileName = `entropy-${entropyKey}.json`;
      const filePath = path.join(this.#improveQueueRoot, fileName);
      let seen = 1;
      try {
        const prev = JSON.parse(await readFile(filePath, "utf8")) as {
          meta?: { seen?: string | number };
        };
        const prevSeen = Number(prev.meta?.seen ?? 0);
        if (Number.isFinite(prevSeen) && prevSeen > 0) {
          seen = prevSeen + 1;
        }
      } catch {
        // first time for this entropy key
      }
      const goal = {
        id: `entropy-${entropyKey}`,
        source: "queue",
        title: action.title,
        prompt: [
          "You are improving XioCode (the coding agent product) from a post-task entropy signal.",
          "Do not auto-merge; MergeGate ask only. Keep changes surgical.",
          "",
          `Entropy key: ${entropyKey} (seen ${seen} time(s); last run ${report.run_id})`,
          `Priority: ${action.priority} · Target: ${action.target}`,
          `Action: ${action.title}`,
          action.detail,
          "",
          `Touchpoints: ${action.touchpoints.join(", ")}`,
          "",
          "## Latest retrospective evidence",
          report.executive_summary,
          "",
          report.markdown,
          "",
          "Implement this durable fix (config defaults or source) justified by the blockers.",
          "Run the smallest verification that proves the fix.",
        ].join("\n"),
        meta: {
          run_id: report.run_id,
          from: "retrospective",
          entropy_key: entropyKey,
          action_id: action.id,
          target: action.target,
          priority: action.priority,
          seen: String(seen),
        },
      };
      await writeFile(filePath, `${JSON.stringify(goal, null, 2)}\n`, "utf8");
      paths.push(filePath);
    }
    return paths;
  }
}

function normsActionsToProposals(actions: RetrospectiveReport["actions"]): NormsProposedFile[] {
  return actions
    .filter((a) => a.target === "norms")
    .map((a) => ({
      relativePath: a.touchpoints[0] && !a.touchpoints[0].startsWith("~")
        ? a.touchpoints[0]
        : "AGENTS.md",
      content: `# Draft from retrospective action ${a.id}\n\n${a.title}\n\n${a.detail}\n`,
      summary: a.title,
    }));
}

function priorityRank(priority: "high" | "medium" | "low"): number {
  if (priority === "high") {
    return 0;
  }
  if (priority === "medium") {
    return 1;
  }
  return 2;
}

/** Load retrospective-enqueued improve goals into a GoalStore-like sink. */
export async function loadRetrospectiveImproveGoals(
  queueRoot: string = path.join(os.homedir(), ".xiocode", "improve", "queue"),
): Promise<readonly Readonly<{
  id: string;
  source: "queue";
  title: string;
  prompt: string;
  meta?: Readonly<Record<string, string>>;
}>[]> {
  try {
    const entries = await readdir(queueRoot);
    const goals = [];
    for (const name of entries.filter((entry) => entry.endsWith(".json")).sort()) {
      try {
        const raw = JSON.parse(await readFile(path.join(queueRoot, name), "utf8")) as {
          id?: string;
          title?: string;
          prompt?: string;
          meta?: Record<string, string>;
        };
        if (typeof raw.prompt === "string" && raw.prompt.length > 0) {
          goals.push({
            id: raw.id ?? name.replace(/\.json$/, ""),
            source: "queue" as const,
            title: raw.title ?? name,
            prompt: raw.prompt,
            ...(raw.meta ? { meta: raw.meta } : {}),
          });
        }
      } catch {
        // skip bad files
      }
    }
    return goals;
  } catch {
    return [];
  }
}
