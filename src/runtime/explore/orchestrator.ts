/**
 * Live explore orchestration: mechanical ownership, global budgets,
 * early-stop / straggler cancel, and WorkspaceBrief aggregation on the
 * real tool path (not simulate-only policy).
 */

import {
  aggregateWorkspaceBrief,
  formatWorkspaceBrief,
  type BriefClaim,
  type BriefCitation,
  type WorkerEvidenceReport,
  type WorkspaceBrief,
  DEFAULT_WORKSPACE_BRIEF_MAX_CHARS,
} from "./brief.ts";
import { planDispatch, shouldEarlyStop } from "./dispatcher.ts";
import type { ExploreLane } from "./lanes.ts";
import type { ExploreConcurrencyBudget } from "./policy.ts";
import type { ExploreRoleId } from "./roles.ts";
import type { ExploreSubagentResult } from "./types.ts";

export type ExploreGlobalBudgets = Readonly<{
  /** Wall-time budget for the whole fan-out wave (ms). */
  wallMs: number;
  /** Soft token budget across workers (input+output when reported). 0 = unlimited. */
  maxTokens: number;
  /** Soft cost budget in USD (0 = unlimited). */
  maxCostUsd: number;
  /**
   * Max worker starts per rolling 60s window (0 = unlimited).
   * Mechanical provider-pressure limiter (session-scoped start rate).
   */
  maxStartsPerMinute?: number;
  /** Early-stop plateau samples. */
  earlyStopMinSamples?: number;
  earlyStopEpsilon?: number;
}>;

export type BeginExploreWorkerInput = Readonly<{
  goal: string;
  focusPaths?: readonly string[];
  role?: ExploreRoleId;
  lane: ExploreLane;
  /** Parent abort (tool timeout / user cancel). */
  parentSignal?: AbortSignal;
}>;

export type BeginExploreWorkerResult = Readonly<{
  workerId: number;
  role?: ExploreRoleId;
  ownership: Readonly<{
    paths: readonly string[];
    questions: readonly string[];
    role?: ExploreRoleId;
  }>;
  /** Combined parent + straggler abort signal. */
  signal: AbortSignal;
  /** True when this worker should not start (fast lane / budget). */
  skip?: Readonly<{ reason: string; code: SkipCode }>;
}>;

export type SkipCode =
  | "fast_lane"
  | "wall_budget"
  | "token_budget"
  | "cost_budget"
  | "provider_rate_budget"
  | "straggler_cancel"
  | "coverage_plateau";

export type CompleteExploreWorkerInput = Readonly<{
  workerId: number;
  result: ExploreSubagentResult;
  role?: ExploreRoleId;
}>;

export type CompleteExploreWorkerResult = Readonly<{
  report: WorkerEvidenceReport;
  brief: WorkspaceBrief;
  briefText: string;
  earlyStopped: boolean;
  cancelledAsStraggler: boolean;
  tokensUsed: number;
  costUsd: number;
}>;

const PATH_RE =
  /(?:^|[\s`"'(=])((?:\/|\.\/|\.\.\/)?[\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|md|json|toml|yaml|yml))\b/gi;
const PATH_LINE_RE =
  /((?:\/|\.\/)?[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|md))\s*:(\d+)(?:-(\d+))?/gi;
const SYMBOL_RE = /\b([A-Z][A-Za-z0-9]{2,}|(?:[a-z]+[A-Z][A-Za-z0-9]+))\b/g;

/**
 * Session-scoped orchestrator shared by all concurrent `explore` tool calls.
 */
export class ExploreOrchestrator {
  readonly #budgets: ExploreGlobalBudgets;
  #nextId = 0;
  #waveStartedAt: number | undefined;
  #tokensUsed = 0;
  #costUsd = 0;
  #claimedPaths = new Set<string>();
  #roleCursor = 0;
  #reports: WorkerEvidenceReport[] = [];
  #coverageHistory: number[] = [];
  #earlyStopped = false;
  #stragglerReason: string | undefined;
  /** Timestamps of worker starts for provider-rate sliding window. */
  #startTimestamps: number[] = [];
  readonly #active = new Map<number, {
    controller: AbortController;
    role?: ExploreRoleId;
    ownershipPaths: readonly string[];
  }>();
  readonly #onParentAbort = new Map<number, () => void>();

  constructor(budgets: ExploreGlobalBudgets) {
    this.#budgets = budgets;
  }

  /** Snapshot of configured global budgets (product registration / tests). */
  get budgets(): ExploreGlobalBudgets {
    return this.#budgets;
  }

  get tokensUsed(): number {
    return this.#tokensUsed;
  }

  get costUsd(): number {
    return this.#costUsd;
  }

  get earlyStopped(): boolean {
    return this.#earlyStopped;
  }

  get reportCount(): number {
    return this.#reports.length;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  /** Aggregate brief of completed workers (≤12KB by default). */
  getBrief(maxChars = DEFAULT_WORKSPACE_BRIEF_MAX_CHARS): WorkspaceBrief {
    return aggregateWorkspaceBrief(this.#reports, { maxChars });
  }

  /**
   * Fast-lane mechanical refuse: simple/single-file without explore request
   * must not start a worker on the real tool path.
   */
  shouldSkipForLane(
    budget: ExploreConcurrencyBudget,
    options: Readonly<{ exploreRequested?: boolean }> = {},
  ): SkipCode | undefined {
    if (budget.lane === "fast" && budget.suggested === 0 && !options.exploreRequested) {
      return "fast_lane";
    }
    if (this.#earlyStopped) return "coverage_plateau";
    if (this.#budgetCode()) return this.#budgetCode();
    return undefined;
  }

  beginWorker(input: BeginExploreWorkerInput): BeginExploreWorkerResult {
    this.#waveStartedAt ??= Date.now();
    const budgetCode = this.#budgetCode();
    if (budgetCode) {
      return this.#skipResult(input, budgetCode, budgetMessage(budgetCode));
    }
    if (this.#earlyStopped) {
      return this.#skipResult(input, "coverage_plateau", "coverage plateau — stragglers cancelled");
    }

    // Count a start only when the worker is allowed to proceed (not skipped).
    this.#startTimestamps.push(Date.now());

    const workerId = ++this.#nextId;
    const role = input.role ?? this.#nextRole(input.lane);
    const requestedPaths = uniquePaths([
      ...(input.focusPaths ?? []),
      ...extractPathsFromText(input.goal),
    ]);
    const ownershipPaths = this.#claimPaths(requestedPaths, role, input.lane, input.goal);
    const questions = [input.goal.trim()].filter((q) => q.length > 0);

    const controller = new AbortController();
    const onParent = () => {
      controller.abort();
    };
    if (input.parentSignal?.aborted) {
      controller.abort();
    } else {
      input.parentSignal?.addEventListener("abort", onParent, { once: true });
      if (input.parentSignal) {
        this.#onParentAbort.set(workerId, () => {
          input.parentSignal?.removeEventListener("abort", onParent);
        });
      }
    }

    this.#active.set(workerId, {
      controller,
      role,
      ownershipPaths,
    });

    return {
      workerId,
      role,
      ownership: {
        paths: ownershipPaths,
        questions,
        role,
      },
      signal: controller.signal,
    };
  }

  completeWorker(input: CompleteExploreWorkerInput): CompleteExploreWorkerResult {
    const active = this.#active.get(input.workerId);
    this.#active.delete(input.workerId);
    this.#onParentAbort.get(input.workerId)?.();
    this.#onParentAbort.delete(input.workerId);

    const cancelledAsStraggler = Boolean(
      active && this.#earlyStopped && input.result.cancelled,
    );

    const role = input.role ?? active?.role;
    const report = parseWorkerEvidenceReport(input.result.text, {
      role,
      ownershipPaths: active?.ownershipPaths ?? [],
      success: input.result.success,
      error: input.result.error,
    });
    this.#reports.push(report);

    const usageTokens = tokenSum(input.result.usage);
    this.#tokensUsed += usageTokens;
    this.#costUsd += estimateCostUsd(input.result.usage);

    const brief = this.getBrief();
    this.#coverageHistory.push(briefCoverageSignal(brief));

    let earlyStopped = this.#earlyStopped;
    if (
      !this.#earlyStopped
      && shouldEarlyStop(this.#coverageHistory, {
        minSamples: this.#budgets.earlyStopMinSamples ?? 3,
        epsilon: this.#budgets.earlyStopEpsilon ?? 0.02,
      })
    ) {
      this.#earlyStopped = true;
      earlyStopped = true;
      this.#stragglerReason = "coverage_plateau";
      this.cancelStragglers("coverage plateau");
    }

    // Hard budgets after completion may also cancel remaining workers.
    const postBudget = this.#budgetCode();
    if (postBudget && this.#active.size > 0) {
      this.#earlyStopped = true;
      earlyStopped = true;
      this.#stragglerReason = postBudget;
      this.cancelStragglers(budgetMessage(postBudget));
    }

    return {
      report,
      brief,
      briefText: formatWorkspaceBrief(brief),
      earlyStopped,
      cancelledAsStraggler,
      tokensUsed: this.#tokensUsed,
      costUsd: this.#costUsd,
    };
  }

  /** Abort all still-running workers (straggler / budget). */
  cancelStragglers(reason: string): number {
    this.#stragglerReason = reason;
    let n = 0;
    for (const [id, entry] of this.#active) {
      if (!entry.controller.signal.aborted) {
        entry.controller.abort();
        n += 1;
      }
      void id;
    }
    return n;
  }

  /** Release ownership leases (tests / wave reset). */
  resetWave(): void {
    this.cancelStragglers("reset");
    this.#active.clear();
    this.#onParentAbort.clear();
    this.#claimedPaths.clear();
    this.#reports = [];
    this.#coverageHistory = [];
    this.#earlyStopped = false;
    this.#stragglerReason = undefined;
    this.#waveStartedAt = undefined;
    this.#tokensUsed = 0;
    this.#costUsd = 0;
    this.#roleCursor = 0;
    this.#startTimestamps = [];
  }

  #budgetCode(): SkipCode | undefined {
    if (this.#waveStartedAt !== undefined) {
      const elapsed = Date.now() - this.#waveStartedAt;
      if (elapsed >= this.#budgets.wallMs) return "wall_budget";
    }
    if (this.#budgets.maxTokens > 0 && this.#tokensUsed >= this.#budgets.maxTokens) {
      return "token_budget";
    }
    if (this.#budgets.maxCostUsd > 0 && this.#costUsd >= this.#budgets.maxCostUsd) {
      return "cost_budget";
    }
    const maxStarts = this.#budgets.maxStartsPerMinute ?? 0;
    if (maxStarts > 0) {
      const now = Date.now();
      const windowMs = 60_000;
      this.#startTimestamps = this.#startTimestamps.filter((t) => now - t < windowMs);
      if (this.#startTimestamps.length >= maxStarts) {
        return "provider_rate_budget";
      }
    }
    return undefined;
  }

  #skipResult(
    input: BeginExploreWorkerInput,
    code: SkipCode,
    reason: string,
  ): BeginExploreWorkerResult {
    const workerId = ++this.#nextId;
    const controller = new AbortController();
    controller.abort();
    return {
      workerId,
      role: input.role,
      ownership: {
        paths: [...(input.focusPaths ?? [])],
        questions: [input.goal],
        role: input.role,
      },
      signal: controller.signal,
      skip: { reason, code },
    };
  }

  #nextRole(lane: ExploreLane): ExploreRoleId | undefined {
    const plan = planDispatch(lane, [], []);
    if (plan.roles.length === 0) return undefined;
    const role = plan.roles[this.#roleCursor % plan.roles.length]!.role.id;
    this.#roleCursor += 1;
    return role;
  }

  /**
   * Mechanical non-overlapping ownership: claim free paths first;
   * fall back to dispatcher plan partition when primary gave no paths.
   */
  #claimPaths(
    requested: readonly string[],
    role: ExploreRoleId | undefined,
    lane: ExploreLane,
    goal: string,
  ): string[] {
    const freeRequested = requested.filter((pathValue) => {
      const key = normalizePathKey(pathValue);
      if (this.#claimedPaths.has(key)) return false;
      this.#claimedPaths.add(key);
      return true;
    });
    if (freeRequested.length > 0) return freeRequested;

    // No free requested paths — assign from plan partition of goal-derived hints.
    const seedPaths = uniquePaths(extractPathsFromText(goal));
    const plan = planDispatch(lane, seedPaths.length > 0 ? seedPaths : [`slice:${role ?? "worker"}`], [goal]);
    const match = role
      ? plan.roles.find((item) => item.role.id === role)
      : plan.roles[this.#roleCursor % Math.max(1, plan.roles.length)];
    const planned = match?.ownership.paths ?? [];
    const claimed: string[] = [];
    for (const pathValue of planned) {
      const key = normalizePathKey(pathValue);
      if (this.#claimedPaths.has(key)) continue;
      this.#claimedPaths.add(key);
      claimed.push(pathValue);
    }
    // Ensure every worker has a non-empty ownership marker for capsule binding.
    if (claimed.length === 0 && role) {
      const synthetic = `role:${role}`;
      if (!this.#claimedPaths.has(synthetic)) {
        this.#claimedPaths.add(synthetic);
        claimed.push(synthetic);
      }
    }
    return claimed;
  }
}

/**
 * Parse worker final text into a structured evidence report for brief aggregation.
 * Heuristic: path:line citations, path mentions, symbols, gap phrases.
 */
export function parseWorkerEvidenceReport(
  text: string,
  options: Readonly<{
    role?: ExploreRoleId | string;
    ownershipPaths?: readonly string[];
    success?: boolean;
    error?: string;
  }> = {},
): WorkerEvidenceReport {
  const body = text.trim();
  const citations = extractCitations(body);
  const pathMentions = extractPathsFromText(body);
  const symbols = extractSymbols(body).slice(0, 24);
  const gaps = extractGaps(body, options.error);
  const claims = buildClaims(body, citations, pathMentions, options.role);

  // Ownership paths without body citations still surface as low-confidence gaps if empty.
  if (claims.length === 0 && (options.ownershipPaths?.length ?? 0) > 0 && body.length === 0) {
    gaps.push("empty worker report for owned paths");
  }

  return {
    role: options.role,
    claims,
    symbols,
    tests: pathMentions.filter((pathValue) => /test/i.test(pathValue)),
    gaps,
    raw_chars: body.length,
  };
}

export function formatOrchestratedExploreResult(input: Readonly<{
  status: "ok" | "error" | "timeout" | "cancelled" | "skipped";
  provider?: string;
  model?: string;
  turns?: number;
  toolCalls?: number;
  toolErrors?: number;
  role?: string;
  ownershipPaths?: readonly string[];
  briefText: string;
  brief: WorkspaceBrief;
  skipReason?: string;
  earlyStopped?: boolean;
  tokensUsed?: number;
  /** Optional short worker note (not raw dump); hard-capped. */
  workerNote?: string;
  maxWorkerNoteChars?: number;
}>): string {
  const lines = [
    `## Explore report (${input.status})`,
  ];
  if (input.provider && input.model) {
    lines.push(`model: ${input.provider}/${input.model}`);
  }
  if (input.turns !== undefined) {
    lines.push(
      `turns: ${input.turns}  tool_calls: ${input.toolCalls ?? 0}  tool_errors: ${input.toolErrors ?? 0}`,
    );
  }
  if (input.role) lines.push(`role: ${input.role}`);
  if (input.ownershipPaths && input.ownershipPaths.length > 0) {
    lines.push(`ownership.paths: ${input.ownershipPaths.join(", ")}`);
  }
  if (input.skipReason) lines.push(`skip: ${input.skipReason}`);
  if (input.earlyStopped) lines.push("early_stop: coverage plateau or budget — stragglers cancelled");
  if (input.tokensUsed !== undefined) {
    lines.push(
      `wave_tokens≈${input.tokensUsed}  brief_chars=${input.brief.text_chars}`
        + ` citation_coverage=${input.brief.citation_coverage.toFixed(2)}`
        + ` overlap=${input.brief.overlap.toFixed(2)}`,
    );
  }
  lines.push("");
  // Aggregate brief is the primary injection (≤12KB). Raw evidence stays in store.
  lines.push(input.briefText);
  if (input.workerNote?.trim()) {
    const cap = input.maxWorkerNoteChars ?? 1_200;
    const note = input.workerNote.trim();
    lines.push("");
    lines.push("### Worker note (truncated; raw evidence in EvidenceStore)");
    lines.push(note.length <= cap ? note : `${note.slice(0, cap)}…`);
  }
  return lines.join("\n");
}

function buildClaims(
  body: string,
  citations: readonly BriefCitation[],
  pathMentions: readonly string[],
  role?: string,
): BriefClaim[] {
  if (body.length === 0) return [];
  const sentences = body
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12 && s.length < 400)
    .slice(0, 8);

  if (sentences.length === 0) {
    return [{
      text: body.slice(0, 240),
      confidence: citations.length > 0 ? 0.7 : 0.4,
      citations: citations.slice(0, 4),
      source_role: role,
    }];
  }

  return sentences.map((sentence, index) => {
    const linked = citations.filter((citation) =>
      sentence.toLowerCase().includes(citation.path.toLowerCase().split("/").pop() ?? "")
      || sentence.includes(citation.path)
    );
    const fallback = linked.length > 0
      ? linked
      : citations.length > 0 && index === 0
        ? citations.slice(0, 2)
        : pathMentions.slice(0, 1).map((pathValue) => ({ path: pathValue }));
    return {
      text: sentence.replace(/\s+/g, " ").slice(0, 320),
      confidence: fallback.length > 0 ? 0.75 : 0.45,
      citations: fallback,
      source_role: role,
    };
  });
}

function extractCitations(text: string): BriefCitation[] {
  const out: BriefCitation[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PATH_LINE_RE)) {
    const pathValue = match[1]!;
    const start = Number(match[2]);
    const end = match[3] ? Number(match[3]) : undefined;
    const key = `${pathValue}:${start}-${end ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      path: pathValue,
      start_line: start,
      end_line: end,
    });
  }
  if (out.length === 0) {
    for (const pathValue of extractPathsFromText(text).slice(0, 8)) {
      out.push({ path: pathValue });
    }
  }
  return out;
}

export function extractPathsFromText(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PATH_RE)) {
    const pathValue = match[1];
    if (pathValue) found.push(pathValue);
  }
  // Also catch bare relative paths without leading separator context.
  const bare = text.match(
    /\b(?:src|packages|tests|extensions|apps)\/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|md)\b/gi,
  );
  if (bare) found.push(...bare);
  return uniquePaths(found);
}

function extractSymbols(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(SYMBOL_RE)) {
    const symbol = match[1];
    if (symbol && symbol.length < 48) out.push(symbol);
  }
  return [...new Set(out)];
}

function extractGaps(text: string, error?: string): string[] {
  const gaps: string[] = [];
  if (error?.trim()) gaps.push(error.trim());
  for (const line of text.split("\n")) {
    if (/\b(gap|not found|could not|unable to|missing|unknown|unresolved)\b/i.test(line)) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && trimmed.length < 240) gaps.push(trimmed);
    }
  }
  return [...new Set(gaps)].slice(0, 12);
}

function briefCoverageSignal(brief: WorkspaceBrief): number {
  // Prefer citation-backed claim density as plateau signal.
  if (brief.claims.length === 0) return 0;
  return 0.5 * brief.citation_coverage + 0.5 * Math.min(1, brief.claims.length / 8);
}

function tokenSum(usage: ExploreSubagentResult["usage"] | undefined): number {
  if (!usage) return 0;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return Math.max(0, input) + Math.max(0, output);
}

function estimateCostUsd(usage: ExploreSubagentResult["usage"] | undefined): number {
  // Conservative placeholder when provider cost map is absent (~$1/M tokens blended).
  const tokens = tokenSum(usage);
  if (tokens <= 0) return 0;
  return tokens * 1e-6;
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pathValue of paths) {
    const trimmed = pathValue.trim();
    if (!trimmed) continue;
    const key = normalizePathKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function normalizePathKey(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function budgetMessage(code: SkipCode): string {
  switch (code) {
    case "wall_budget":
      return "global wall-time budget exhausted";
    case "token_budget":
      return "global token budget exhausted";
    case "cost_budget":
      return "global cost budget exhausted";
    case "provider_rate_budget":
      return "provider-rate budget exhausted (max explore starts per minute)";
    case "fast_lane":
      return "fast lane: do not spawn explore for simple single-file tasks";
    case "coverage_plateau":
      return "coverage plateau — stragglers cancelled";
    case "straggler_cancel":
      return "cancelled as low-value straggler";
    default:
      return code;
  }
}
