import { defineTool } from "../define-tool.ts";
import { resolveApiKey } from "../providers/client.ts";
import { Type } from "../schema.ts";
import type { ThinkingLevel } from "../types.ts";

import type { ProviderRegistration, ToolDefinition } from "../types.ts";
import { EvidenceStore } from "../workspace/evidence-store.ts";
import type { WorkspacePerceptionService } from "../workspace/service.ts";
import {
  appendBriefGaps,
  DEFAULT_WORKSPACE_BRIEF_MAX_CHARS,
  formatWorkspaceBrief,
  type WorkspaceBrief,
} from "./brief.ts";
import { buildPolicyCapsule } from "./capsule.ts";
import {
  ExploreOrchestrator,
  formatOrchestratedExploreResult,
  type BeginExploreWorkerResult,
  type SkipCode,
} from "./orchestrator.ts";
import {
  DEFAULT_EXPLORE_ACTIVE_MAX,
  detectUserExploreFanoutRequest,
  resolveExploreConcurrencyBudget,
  ULTRA_EXPLORE_ACTIVE_MIN,
  type ExploreConcurrencyBudget,
} from "./policy.ts";
import type { ExploreRoleId } from "./roles.ts";
import { Semaphore } from "./semaphore.ts";
import { runExploreSubagent, type RunExploreSubagentOptions } from "./subagent.ts";
import type { ExploreSubagentResult, ResolvedExploreConfig } from "./types.ts";
import { MAX_EXPLORE_CONCURRENCY } from "./types.ts";

const EXPLORE_ROLE_IDS = new Set<ExploreRoleId>([
  "locator",
  "flow_analyst",
  "impact_test",
  "adversarial",
]);

export const EXPLORE_TOOL_NAME = "explore";

const MULTI_EXPLORE_MARKER = "## Multi-explore (read-only subagents)";

/**
 * Static fallback for marker matching in tests.
 * Prefer formatPrimaryExploreAddendum with live budget + scale.
 */
export const PRIMARY_EXPLORE_PROMPT_ADDENDUM = formatPrimaryExploreAddendum({
  maxConcurrency: MAX_EXPLORE_CONCURRENCY,
  suggestedConcurrency: DEFAULT_EXPLORE_ACTIVE_MAX,
  effectiveMax: DEFAULT_EXPLORE_ACTIVE_MAX,
  mode: "default",
});

/** Strip a previous Multi-explore section so each turn can re-apply policy text. */
export function stripMultiExploreAddendum(systemPrompt: string): string {
  const idx = systemPrompt.indexOf(MULTI_EXPLORE_MARKER);
  if (idx < 0) {
    return systemPrompt.trimEnd();
  }
  const before = systemPrompt.slice(0, idx).trimEnd();
  const rest = systemPrompt.slice(idx + MULTI_EXPLORE_MARKER.length);
  const nextHeading = rest.search(/\n## /);
  const after = nextHeading >= 0 ? rest.slice(nextHeading).trimStart() : "";
  if (before.length === 0) return after;
  if (after.length === 0) return before;
  return `${before}\n\n${after}`;
}

/** Primary-agent guidance: adaptive lanes + user-request fan-out policy. */
export function formatPrimaryExploreAddendum(
  options: Readonly<{
    /** Config hard ceiling (1–16). */
    maxConcurrency: number;
    suggestedConcurrency?: number;
    /** Mechanical parallel cap this turn. */
    effectiveMax?: number;
    mode?: ExploreConcurrencyBudget["mode"];
    lane?: ExploreConcurrencyBudget["lane"];
    scaleNote?: string;
    partitionHint?: string;
    thinkingLevel?: ThinkingLevel;
  }>,
): string {
  const hardCap = Math.min(Math.max(1, options.maxConcurrency), MAX_EXPLORE_CONCURRENCY);
  const effectiveMax = Math.min(
    hardCap,
    Math.max(0, options.effectiveMax ?? DEFAULT_EXPLORE_ACTIVE_MAX),
  );
  const suggestedRaw = options.suggestedConcurrency
    ?? Math.min(DEFAULT_EXPLORE_ACTIVE_MAX, Math.max(1, effectiveMax));
  const suggested = Math.min(Math.max(effectiveMax, 0), Math.max(0, suggestedRaw));
  const mode = options.mode ?? "default";
  const lane = options.lane ?? (mode === "ultra" ? "deep" : mode === "user" ? "explicit_high" : mode === "fast" ? "fast" : "standard");
  const think = options.thinkingLevel ?? "off";

  const lines = [
    MULTI_EXPLORE_MARKER,
    "You have an `explore` tool that runs a faster/cheaper **read-only** subagent on a separate model.",
    "",
    "When to use explore (default for pure reading):",
    "- Multi-file locate/survey/understand work: **prefer `explore`** with specialized slices instead of bulk primary `read`/`grep`.",
    "- Simple **single-file** edits with no unresolved uncertainty: **do not spawn** explore unless the user asks.",
    "- Main agent stays for planning, synthesis, and **write/edit/bash** that change the tree.",
    "- Do not send the whole monorepo as one explore goal — partition into small role-owned slices.",
    "",
    "### Adaptive fan-out (lanes)",
    `Current thinking effort: **${think}**. Config hard ceiling: **${hardCap}** (absolute max ${MAX_EXPLORE_CONCURRENCY}).`,
    `Lane: **${lane}**. Mechanical concurrent cap: **${effectiveMax}**. Prefer about **${suggested}** parallel explore call(s).`,
    "- Lanes: **fast**(0) · **standard**(2–4) · **deep**(4–8) · **explicit_high**(≤16 user-only).",
  ];

  if (mode === "fast" || suggested === 0) {
    lines.push(
      `- **Fast lane**: do **not** spawn subagents for this turn unless the user requests explore or uncertainty remains.`,
    );
  } else if (mode === "ultra" || lane === "deep") {
    lines.push(
      `- **Deep lane** (ultra thinking or high multi-file uncertainty): raise the ceiling toward **${ULTRA_EXPLORE_ACTIVE_MIN}** `
        + `(target ~${Math.max(suggested, 1)}, up to ${Math.max(effectiveMax, 1)}). Prefer role slices: locator / flow / impact / adversarial.`,
      `- Ultra elevates the deep ceiling; it does **not** force workers on trivial single-file tasks.`,
    );
  } else if (mode === "user") {
    lines.push(
      `- User **explicitly** requested high fan-out: you may use up to **${Math.max(effectiveMax, 1)}** concurrent explores `
        + `(including 16 when allowed). Still partition into small non-overlapping ownerships.`,
    );
  } else {
    lines.push(
      `- **Standard lane**: about **2–${DEFAULT_EXPLORE_ACTIVE_MAX}** concurrent explores with non-overlapping ownership.`,
      `- Do **not** issue 8–16 explores unless the user clearly asks for that many workers `
        + `(e.g. "16 subagents" / "开16个explore") — then the cap rises for that turn only.`,
      `- Deep ceiling without a user count: set thinking effort to **ultra** (\`/effort ultra\` or Tab) when multi-file uncertainty is high.`,
    );
  }

  lines.push(
    "",
    "Each subagent must own only a **small** slice — dispatcher ownership (paths/questions), not vague prompts alone.",
    "You choose how to partition (API surface, feature, package/layer, call path, file tree, bug surface, …)",
    "based on the project and the user request; the user may also dictate the partition.",
    "Prefer many narrow explores over few broad ones; if a slice is still large, split further (within the cap).",
    "Issue multiple `explore` tool calls in one turn for parallel slices, then synthesize a compact WorkspaceBrief",
    "(claims + citations; raw evidence stays out of primary context). Workers cannot modify files or spawn further explores.",
    "Pass a narrow research `goal` plus optional `focus_paths` for that slice only.",
    "",
    "Trust rules for explore returns:",
    "- Workers must return **absolute paths** and **verbatim file content** for what they read.",
    "- Treat code blocks as source evidence; do not assume they rewrote or \"cleaned\" code.",
    "- If a report is truncated or incomplete, re-explore a narrower path or `read` that absolute path yourself — never invent missing text.",
  );
  if (options.scaleNote?.trim()) {
    lines.push(`Workspace scale: ${options.scaleNote.trim()}`);
  }
  if (options.partitionHint?.trim()) {
    lines.push(`User/project partition preference: ${options.partitionHint.trim()}`);
  }
  return lines.join("\n");
}

export type CreateExploreToolOptions = Readonly<{
  config: ResolvedExploreConfig;
  cwd: string;
  workspaceRoot: string;
  getProvider: (name: string) => ProviderRegistration | undefined;
  env?: NodeJS.ProcessEnv;
  onNotify?: (message: string) => void;
  /** Header status: active subagent count (e.g. setStatus("explore", "subs:2")). */
  onStatus?: (key: string, text: string | undefined) => void;
  /** Session thinking level (drives ultra fan-out). */
  getThinkingLevel?: () => ThinkingLevel;
  /** Latest user prompt for high-fan-out detection. */
  getUserPrompt?: () => string;
  /** Shared workspace perception for worker query/evidence tools. */
  workspacePerception?: WorkspacePerceptionService;
  /**
   * Session-scoped orchestrator (ownership / budgets / brief / early-stop).
   * Shared across concurrent explore tool calls when provided by register.
   */
  orchestrator?: ExploreOrchestrator;
  /** Test seam: replace nested subagent runner. */
  runWorker?: (options: RunExploreSubagentOptions) => Promise<ExploreSubagentResult>;
  /** Global wall budget for the fan-out wave (defaults to config.timeoutMs). */
  globalWallMs?: number;
  /** Soft token budget across workers (defaults to config.maxTokens; 0 = unlimited). */
  globalMaxTokens?: number;
  /** Soft cost budget USD across workers (defaults to config.maxCostUsd; 0 = unlimited). */
  globalMaxCostUsd?: number;
  /** Max worker starts / minute (defaults to config.maxStartsPerMinute; 0 = unlimited). */
  globalMaxStartsPerMinute?: number;
}>;

export function createExploreTool(options: CreateExploreToolOptions): ToolDefinition {
  const env = options.env ?? process.env;
  const hardCap = Math.min(options.config.maxConcurrency, MAX_EXPLORE_CONCURRENCY);
  let activeWorkers = 0;

  const orchestrator = options.orchestrator ?? new ExploreOrchestrator({
    wallMs: options.globalWallMs ?? options.config.timeoutMs,
    maxTokens: options.globalMaxTokens ?? options.config.maxTokens,
    maxCostUsd: options.globalMaxCostUsd ?? options.config.maxCostUsd,
    maxStartsPerMinute: options.globalMaxStartsPerMinute ?? options.config.maxStartsPerMinute,
  });
  const runWorker = options.runWorker ?? runExploreSubagent;

  const publishActiveStatus = (): void => {
    if (activeWorkers <= 0) {
      options.onStatus?.("explore", undefined);
      return;
    }
    options.onStatus?.("explore", `subs:${activeWorkers}`);
  };

  const resolveBudget = (): ExploreConcurrencyBudget => {
    const userText = options.getUserPrompt?.() ?? "";
    const userRequest = detectUserExploreFanoutRequest(userText);
    return resolveExploreConcurrencyBudget({
      thinkingLevel: options.getThinkingLevel?.() ?? "off",
      configMax: hardCap,
      userRequest,
      signal: {
        userText,
        exploreRequested: userRequest.highFanout || /\bexplore\b/i.test(userText),
      },
    });
  };

  const exploreRequestedNow = (): boolean => {
    const userText = options.getUserPrompt?.() ?? "";
    const userRequest = detectUserExploreFanoutRequest(userText);
    return userRequest.highFanout || /\bexplore\b/i.test(userText);
  };

  const gate = new Semaphore(() => Math.max(1, resolveBudget().effectiveMax));

  return defineTool({
    name: EXPLORE_TOOL_NAME,
    label: "Explore",
    description:
      "Spawn one read-only subagent for a **small** research slice (not a whole feature/module). "
      + "Prefer this for multi-file locate/survey; skip for simple single-file work unless asked. "
      + `Adaptive lanes: fast(0) / standard(≤${DEFAULT_EXPLORE_ACTIVE_MAX}) / deep(≤${ULTRA_EXPLORE_ACTIVE_MIN}) / `
      + `user high fan-out up to ${hardCap} (absolute max ${MAX_EXPLORE_CONCURRENCY}). `
      + "Returns a compact WorkspaceBrief (≤12KB aggregate) with citations; raw evidence stays in store.",
    promptSnippet: "Read-only explore subagents: narrow slices, WorkspaceBrief aggregate back",
    parameters: Type.Object({
      goal: Type.String({
        description:
          "One narrow research question for this worker only. Do not pack multiple areas into one goal.",
      }),
      focus_paths: Type.Array(Type.String({ description: "Optional path/glob hints." }), {
        description: "Paths for this slice only; keep the worker inside a small boundary.",
      }),
      max_turns: Type.Number({
        description: `Optional turn cap for this worker (1–${options.config.maxTurns}, default config).`,
      }),
      role: Type.String({
        description:
          "Optional specialized role: locator | flow_analyst | impact_test | adversarial (deep lane).",
      }),
    }, { required: ["goal"] }),
    async execute(_id, params, ctx) {
      const goal = typeof params.goal === "string" ? params.goal.trim() : "";
      if (goal.length === 0) {
        return {
          content: [{ type: "text", text: "explore error: goal is required" }],
          isError: true,
        };
      }
      const focusPaths = parseFocusPaths(params.focus_paths);
      const maxTurns = clampTurns(params.max_turns, options.config.maxTurns);
      const role = parseExploreRole(params.role);
      const budget = resolveBudget();

      // Mechanical fast-lane refuse on the real tool path (not prompt-only).
      const laneSkip = orchestrator.shouldSkipForLane(budget, {
        exploreRequested: exploreRequestedNow(),
      });
      if (laneSkip) {
        const emptyBrief = briefForSkip(orchestrator.getBrief(), laneSkip);
        return {
          content: [{
            type: "text",
            text: formatOrchestratedExploreResult({
              status: "skipped",
              role,
              ownershipPaths: focusPaths,
              briefText: formatWorkspaceBrief(emptyBrief),
              brief: emptyBrief,
              skipReason: laneSkip === "fast_lane"
                ? "fast lane: simple/single-file task — do not spawn explore unless uncertainty remains or user asks"
                : laneSkip,
              earlyStopped: orchestrator.earlyStopped,
              tokensUsed: orchestrator.tokensUsed,
            }),
          }],
          isError: false,
          details: {
            explore: {
              skipped: true,
              skipCode: laneSkip,
              lane: budget.lane,
              suggested: budget.suggested,
            },
            brief: emptyBrief,
          },
        };
      }

      const registration = options.getProvider(options.config.provider);
      if (!registration) {
        return {
          content: [{
            type: "text",
            text: `explore error: provider not registered: ${options.config.provider}`,
          }],
          isError: true,
        };
      }

      let release: (() => void) | undefined;
      const timeout = createTimeoutSignal(ctx?.signal, options.config.timeoutMs);
      let begin: BeginExploreWorkerResult | undefined;
      let counted = false;
      try {
        release = await gate.acquire();
        // Re-check budgets after waiting on the semaphore (stragglers / wall may have fired).
        const postWaitSkip = orchestrator.shouldSkipForLane(budget, {
          exploreRequested: exploreRequestedNow(),
        });
        if (postWaitSkip && postWaitSkip !== "fast_lane") {
          const brief = briefForSkip(orchestrator.getBrief(), postWaitSkip);
          return {
            content: [{
              type: "text",
              text: formatOrchestratedExploreResult({
                status: "skipped",
                role,
                ownershipPaths: focusPaths,
                briefText: formatWorkspaceBrief(brief),
                brief,
                skipReason: postWaitSkip,
                earlyStopped: true,
                tokensUsed: orchestrator.tokensUsed,
              }),
            }],
            isError: false,
            details: {
              explore: { skipped: true, skipCode: postWaitSkip, lane: budget.lane },
              brief,
            },
          };
        }

        begin = orchestrator.beginWorker({
          goal,
          focusPaths,
          role,
          lane: budget.lane ?? "standard",
          parentSignal: timeout.signal,
        });
        if (begin.skip) {
          const brief = briefForSkip(orchestrator.getBrief(), begin.skip.code, begin.skip.reason);
          return {
            content: [{
              type: "text",
              text: formatOrchestratedExploreResult({
                status: "skipped",
                role: begin.role ?? role,
                ownershipPaths: begin.ownership.paths,
                briefText: formatWorkspaceBrief(brief),
                brief,
                skipReason: begin.skip.reason,
                earlyStopped: orchestrator.earlyStopped,
                tokensUsed: orchestrator.tokensUsed,
              }),
            }],
            isError: false,
            details: {
              explore: {
                skipped: true,
                skipCode: begin.skip.code,
                lane: budget.lane,
                ownership: begin.ownership,
              },
              brief,
            },
          };
        }

        activeWorkers += 1;
        counted = true;
        const workerId = begin.workerId;
        const assignedRole = begin.role ?? role;
        const ownershipPaths = begin.ownership.paths.filter((p) => !p.startsWith("role:") && !p.startsWith("slice:"));
        const workerFocus = ownershipPaths.length > 0
          ? ownershipPaths
          : focusPaths;

        publishActiveStatus();
        options.onNotify?.(
          `subagent #${workerId} started → ${options.config.provider}/${options.config.model}`
            + ` [${budget.lane ?? budget.mode} cap ${budget.effectiveMax}`
            + `${assignedRole ? ` role=${assignedRole}` : ""}`
            + `${workerFocus?.length ? ` paths=${workerFocus.length}` : ""}]: ${truncate(goal, 80)}`,
        );
        let apiKey: string;
        try {
          apiKey = resolveApiKey(registration, env);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Still complete orchestrator so ownership leases / counters stay consistent.
          const failed: ExploreSubagentResult = {
            provider: options.config.provider,
            model: options.config.model,
            success: false,
            text: "",
            turns: 0,
            toolCalls: 0,
            toolErrors: 0,
            usage: {
              inputTokens: null,
              outputTokens: null,
              cacheTokens: null,
              reasoningTokens: null,
            },
            error: message,
          };
          const completion = orchestrator.completeWorker({
            workerId,
            result: failed,
            role: assignedRole,
          });
          return {
            content: [{ type: "text", text: `explore error: ${message}` }],
            isError: true,
            details: { explore: failed, brief: completion.brief },
          };
        }

        const capsule = buildPolicyCapsule({
          workspaceId: options.workspaceRoot,
          mainRootHint: options.workspaceRoot,
          ownership: {
            role: assignedRole,
            paths: begin.ownership.paths,
            questions: begin.ownership.questions,
          },
          wallMs: options.config.timeoutMs,
          maxTurns,
          maxOutputChars: options.config.maxOutputChars,
        });

        const result = await runWorker({
          goal,
          focusPaths: workerFocus,
          cwd: options.cwd,
          workspaceRoot: options.workspaceRoot,
          registration,
          apiKey,
          modelId: options.config.model,
          maxTurns,
          allowBash: options.config.allowBash,
          signal: begin.signal,
          role: assignedRole,
          capsule,
          workspacePerception: options.workspacePerception,
        });

        // Persist raw worker body into EvidenceStore; primary gets brief only.
        storeRawWorkerEvidence({
          perception: options.workspacePerception,
          workerId,
          role: assignedRole,
          text: result.text,
        });

        const timedOut = timeout.timedOut || Boolean(result.timedOut);
        const completion = orchestrator.completeWorker({
          workerId,
          result: {
            ...result,
            success: timedOut ? false : result.success,
            timedOut,
            cancelled: result.cancelled || begin.signal.aborted,
            error: timedOut
              ? (result.error ?? `timed out after ${options.config.timeoutMs}ms`)
              : result.error,
          },
          role: assignedRole,
        });

        const status = timedOut
          ? "timeout"
          : result.cancelled || completion.cancelledAsStraggler
            ? "cancelled"
            : result.success
              ? "ok"
              : "error";

        options.onNotify?.(
          `subagent #${workerId} ${status}`
            + ` (${result.turns} turns, ${result.toolCalls} tools`
            + `${completion.earlyStopped ? ", early-stop" : ""}): ${truncate(goal, 60)}`,
        );

        // Prefer aggregate WorkspaceBrief (≤12KB) over raw dump.
        const briefText = completion.briefText.length <= DEFAULT_WORKSPACE_BRIEF_MAX_CHARS
          ? completion.briefText
          : formatWorkspaceBrief(orchestrator.getBrief(DEFAULT_WORKSPACE_BRIEF_MAX_CHARS));

        return {
          content: [{
            type: "text",
            text: formatOrchestratedExploreResult({
              status,
              provider: result.provider,
              model: result.model,
              turns: result.turns,
              toolCalls: result.toolCalls,
              toolErrors: result.toolErrors,
              role: assignedRole,
              ownershipPaths: begin.ownership.paths,
              briefText,
              brief: completion.brief,
              earlyStopped: completion.earlyStopped,
              tokensUsed: completion.tokensUsed,
              // Tiny factual lead-in only — not the full raw dump.
              workerNote: firstLines(result.text, 6),
              maxWorkerNoteChars: 1_200,
            }),
          }],
          isError: status === "error" || status === "timeout",
          details: {
            explore: {
              ...result,
              timedOut,
              role: assignedRole,
              ownership: begin.ownership,
              earlyStopped: completion.earlyStopped,
              cancelledAsStraggler: completion.cancelledAsStraggler,
            },
            brief: completion.brief,
            report: completion.report,
          },
        };
      } finally {
        if (counted) {
          activeWorkers = Math.max(0, activeWorkers - 1);
          publishActiveStatus();
        }
        timeout.dispose();
        release?.();
      }
    },
  });
}

function storeRawWorkerEvidence(input: Readonly<{
  perception?: WorkspacePerceptionService;
  workerId: number;
  role?: ExploreRoleId;
  text: string;
}>): void {
  const text = input.text.trim();
  if (!text || !input.perception) return;
  try {
    input.perception.evidence.putSnippet({
      path: `explore://worker/${input.workerId}${input.role ? `/${input.role}` : ""}`,
      text,
      startLine: 1,
      endLine: Math.max(1, text.split("\n").length),
      hash: EvidenceStore.contentHash(text),
    });
  } catch {
    // Evidence store must not fail the explore tool path.
  }
}

/** Budget / early-stop skips must keep incompleteness visible in brief.gaps (not skip text alone). */
function briefForSkip(
  brief: WorkspaceBrief,
  code: SkipCode,
  reason?: string,
): WorkspaceBrief {
  if (code === "fast_lane") return brief;
  const detail = reason?.trim() || code;
  return appendBriefGaps(brief, [`incomplete coverage: ${code} — ${detail}`]);
}

function firstLines(text: string, maxLines: number): string {
  const lines = text.trim().split("\n");
  if (lines.length <= maxLines) return text.trim();
  return `${lines.slice(0, maxLines).join("\n")}\n…`;
}

export function formatExploreResult(
  result: Readonly<{
    provider: string;
    model: string;
    success: boolean;
    cancelled?: boolean;
    timedOut?: boolean;
    text: string;
    turns: number;
    toolCalls: number;
    toolErrors: number;
    error?: string;
  }>,
  maxOutputChars: number,
): string {
  const status = result.timedOut
    ? "timeout"
    : result.cancelled
      ? "cancelled"
      : result.success
        ? "ok"
        : "error";
  const body = result.error && result.text.length === 0
    ? result.error
    : truncate(result.text.trim() || result.error || "(empty report)", maxOutputChars);
  return [
    `## Explore report (${status})`,
    `model: ${result.provider}/${result.model}`,
    `turns: ${result.turns}  tool_calls: ${result.toolCalls}  tool_errors: ${result.toolErrors}`,
    "",
    body,
  ].join("\n");
}

function parseFocusPaths(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const paths = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return paths.length > 0 ? paths : undefined;
}

function parseExploreRole(value: unknown): ExploreRoleId | undefined {
  if (typeof value !== "string") return undefined;
  const role = value.trim() as ExploreRoleId;
  return EXPLORE_ROLE_IDS.has(role) ? role : undefined;
}

function clampTurns(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return max;
  }
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > max) return max;
  return n;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return (
    `${text.slice(0, maxChars)}\n`
    + `…[truncated ${omitted} chars by explore.max_output_chars — `
    + "do not invent omitted text; re-explore a smaller path or raise max_output_chars / read the absolute path]"
  );
}

function createTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: boolean; dispose: () => void } {
  const controller = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onParentAbort = () => {
    controller.abort();
  };
  if (parent?.aborted) {
    controller.abort();
  } else {
    parent?.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    get timedOut() {
      return state.timedOut;
    },
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}
