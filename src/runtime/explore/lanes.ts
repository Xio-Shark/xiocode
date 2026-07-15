import type { ThinkingLevel } from "../types.ts";
import type { ExploreScaleEstimate } from "./scale.ts";
import { MAX_EXPLORE_CONCURRENCY } from "./types.ts";

/** Keep numeric policy constants here to avoid circular imports with policy.ts. */
const DEFAULT_ACTIVE_MAX = 4;
const DEEP_ACTIVE_MIN = 8;

/** Adaptive explore lanes (replaces fixed ultra=>8+ spawn mandate). */
export type ExploreLane = "fast" | "standard" | "deep" | "explicit_high";

export type TaskExploreSignal = Readonly<{
  /** User text for the current turn (optional). */
  userText?: string;
  /** Heuristic: task appears limited to a single file or trivial scope. */
  singleFile?: boolean;
  /** Unresolved uncertainty remains after primary tools / prior evidence. */
  unresolvedUncertainty?: boolean;
  /** User explicitly requested explore / subagents. */
  exploreRequested?: boolean;
  thinkingLevel: ThinkingLevel;
  userRequest: Readonly<{ highFanout: boolean; requestedCount?: number }>;
  scale?: ExploreScaleEstimate;
}>;

export type LaneDecision = Readonly<{
  lane: ExploreLane;
  /** Mechanical concurrent cap. */
  effectiveMax: number;
  /** Prompt guidance for how many to issue (0 = do not spawn). */
  suggested: number;
  mode: "default" | "ultra" | "user" | "fast";
  hardCap: number;
  reason: string;
}>;

/**
 * Select explore lane from task/uncertainty/coverage signals.
 * - fast (0): simple/single-file without uncertainty or user request
 * - standard (2–4): default multi-file
 * - deep (4–8): high uncertainty / ultra thinking with evidence need
 * - explicit_high (up to 16): user high fan-out only
 */
export function selectExploreLane(signal: TaskExploreSignal): LaneDecision {
  const hardCap = MAX_EXPLORE_CONCURRENCY;
  const configMax = hardCap;

  if (signal.userRequest.highFanout) {
    const requested = signal.userRequest.requestedCount ?? hardCap;
    const effectiveMax = Math.min(hardCap, Math.max(DEFAULT_ACTIVE_MAX, requested));
    const suggested = Math.min(effectiveMax, requested);
    return {
      lane: "explicit_high",
      effectiveMax,
      suggested: Math.max(1, suggested),
      mode: "user",
      hardCap: configMax,
      reason: "user explicitly requested high fan-out",
    };
  }

  const wantsExplore = signal.exploreRequested === true
    || Boolean(signal.userText && /\b(explore|survey|locate|find where|仓库|扫一遍)\b/i.test(signal.userText));
  const singleFile = signal.singleFile === true
    || Boolean(signal.userText && isLikelySingleFileTask(signal.userText));
  const uncertain = signal.unresolvedUncertainty === true;

  if (singleFile && !uncertain && !wantsExplore) {
    return {
      lane: "fast",
      effectiveMax: Math.min(DEFAULT_ACTIVE_MAX, hardCap),
      suggested: 0,
      mode: "fast",
      hardCap: configMax,
      reason: "simple/single-file task without unresolved uncertainty",
    };
  }

  const deepByThinking = signal.thinkingLevel === "ultra";
  const deepByUncertainty = uncertain && !singleFile;
  if (deepByThinking || deepByUncertainty) {
    const effectiveMax = Math.min(hardCap, Math.max(DEEP_ACTIVE_MIN, DEFAULT_ACTIVE_MAX * 2));
    const scaleSuggest = scaleSuggestWorkers(signal.scale, effectiveMax);
    // Ultra raises ceiling; does not force 8+ when coverage already high / scale tiny.
    const suggested = Math.min(
      effectiveMax,
      Math.max(DEFAULT_ACTIVE_MAX, Math.min(DEEP_ACTIVE_MIN, scaleSuggest)),
    );
    return {
      lane: "deep",
      effectiveMax,
      suggested,
      mode: deepByThinking ? "ultra" : "default",
      hardCap: configMax,
      reason: deepByThinking
        ? "ultra thinking elevates deep lane ceiling"
        : "unresolved multi-file uncertainty",
    };
  }

  const effectiveMax = Math.min(DEFAULT_ACTIVE_MAX, hardCap);
  const suggested = Math.max(2, Math.min(effectiveMax, scaleSuggestWorkers(signal.scale, effectiveMax)));
  return {
    lane: "standard",
    effectiveMax,
    suggested,
    mode: "default",
    hardCap: configMax,
    reason: "standard multi-file exploration",
  };
}

function scaleSuggestWorkers(scale: ExploreScaleEstimate | undefined, cap: number): number {
  if (!scale) return Math.min(DEFAULT_ACTIVE_MAX, cap);
  switch (scale.tier) {
    case "tiny":
      return Math.min(2, cap);
    case "small":
      return Math.min(3, cap);
    case "medium":
      return Math.min(4, cap);
    case "large":
      return Math.min(6, cap);
    case "huge":
      return Math.min(8, cap);
    default:
      return Math.min(DEFAULT_ACTIVE_MAX, cap);
  }
}

function isLikelySingleFileTask(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Named single path with a common source extension and no multi-file cues.
  const singlePath = /(?:^|\s)[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|md)(?:\s|$)/i.test(trimmed);
  const multiCue = /across|multi[- ]?file|whole (?:repo|codebase)|packages?\/|and\s+[\w./-]+\./i.test(trimmed);
  return singlePath && !multiCue;
}
