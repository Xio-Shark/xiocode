import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RunStore } from "../run-store.ts";
import type { RunSummary } from "../types.ts";
import { extractBlockerLog, type EventRow, type TrajectorySnapshot } from "./extract.ts";
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
  improveQueueRoot?: string;
  notify?: (message: string) => void;
}>;

export type RetrospectiveResult = Readonly<{
  skipped: boolean;
  reason?: string;
  log?: BlockerLog;
  report?: RetrospectiveReport;
  paths?: Readonly<{
    logJson: string;
    reportJson: string;
    reportMd: string;
    /** First enqueued goal (compat). */
    improveGoal?: string;
    /** All entropy-keyed improve goals written this run. */
    improveGoals?: readonly string[];
  }>;
}>;

/**
 * After a full task/run finishes: extract blockers → write log → wash report → enqueue / inject.
 */
export class RetrospectiveRunner {
  readonly #store: RunStore;
  readonly #config: RetrospectiveConfig;
  readonly #summarizeWithLlm?: RetrospectiveRunnerOptions["summarizeWithLlm"];
  readonly #improveQueueRoot: string;
  readonly #notify?: (message: string) => void;
  #pendingInjection: string | undefined;

  constructor(options: RetrospectiveRunnerOptions) {
    this.#store = options.runStore;
    this.#config = { ...DEFAULT_RETROSPECTIVE_CONFIG, ...options.config };
    this.#summarizeWithLlm = options.summarizeWithLlm;
    this.#improveQueueRoot = options.improveQueueRoot
      ?? path.join(os.homedir(), ".xiocode", "improve", "queue");
    this.#notify = options.notify;
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

  async runForFinishedTask(input: Readonly<{
    runId: string;
    summary: RunSummary;
    /** agent_end success flag from loop (may differ from summary). */
    agentSuccess?: boolean;
    cancelled?: boolean;
  }>): Promise<RetrospectiveResult> {
    if (!this.#config.enabled) {
      return { skipped: true, reason: "disabled" };
    }
    if (input.cancelled) {
      return { skipped: true, reason: "cancelled" };
    }

    const events = await this.#readEvents(input.runId);
    const trajectory = await this.#readTrajectory(input.runId);
    const log = extractBlockerLog({
      runId: input.runId,
      summary: input.summary,
      events,
      trajectory,
    });

    if (this.#config.skipTrivial && log.tool_call_count < this.#config.minToolCalls && log.blockers.length === 0) {
      return { skipped: true, reason: "trivial" };
    }

    let llmSummary: string | undefined;
    const draft = washRetrospectiveReport(log);
    if (this.#config.useLlm && this.#summarizeWithLlm) {
      try {
        llmSummary = await this.#summarizeWithLlm({ log, draftMarkdown: draft.markdown });
      } catch (error) {
        this.#notify?.(
          `retrospective LLM polish failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const report = washRetrospectiveReport(log, { llmSummary });

    const logJson = "blockers.log.json";
    const reportJson = "retrospective-report.json";
    const reportMd = "retrospective-report.md";
    await this.#store.writeJson(input.runId, logJson, log);
    await this.#store.writeJson(input.runId, reportJson, report);
    await this.#store.writeText(input.runId, reportMd, report.markdown);

    let improveGoalPaths: string[] = [];
    if (this.#config.enqueueImprove && report.actions.length > 0) {
      improveGoalPaths = await this.#enqueueImproveGoals(report);
    }

    if (this.#config.autoInject && report.pending_for_main) {
      this.#pendingInjection = formatInjectionContext(report);
    }

    this.#notify?.(
      `retrospective: ${log.blockers.length} blocker(s) → ${this.#store.filePath(input.runId, reportMd)}`
        + (improveGoalPaths.length > 0 ? ` (+${improveGoalPaths.length} improve goal(s))` : ""),
    );

    return {
      skipped: false,
      log,
      report,
      paths: {
        logJson: this.#store.filePath(input.runId, logJson),
        reportJson: this.#store.filePath(input.runId, reportJson),
        reportMd: this.#store.filePath(input.runId, reportMd),
        ...(improveGoalPaths[0] ? { improveGoal: improveGoalPaths[0] } : {}),
        ...(improveGoalPaths.length > 0 ? { improveGoals: improveGoalPaths } : {}),
      },
    };
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

  /**
   * Enqueue high/medium actions as entropy-keyed goals (stable id = action.id).
   * Same bad pattern from later runs overwrites the goal with fresher evidence — never auto-merge.
   */
  async #enqueueImproveGoals(report: RetrospectiveReport): Promise<string[]> {
    await mkdir(this.#improveQueueRoot, { recursive: true });
    const ranked = [...report.actions].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
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
