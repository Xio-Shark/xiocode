import type { ThinkingLevel } from "../types.ts";

import { selectExploreLane, type ExploreLane, type TaskExploreSignal } from "./lanes.ts";
import { suggestExploreConcurrency, type ExploreScaleEstimate } from "./scale.ts";
import { MAX_EXPLORE_CONCURRENCY } from "./types.ts";

/** Default concurrent explore budget when not ultra and user did not request high fan-out. */
export const DEFAULT_EXPLORE_ACTIVE_MAX = 4;

/**
 * Deep-lane ceiling target (was hard ultra=>8+ spawn mandate).
 * Ultra elevates the lane ceiling; suggested count still follows coverage/scale.
 */
export const ULTRA_EXPLORE_ACTIVE_MIN = 8;

export type ExploreFanoutRequest = Readonly<{
  /** User asked for wider-than-default parallel explores (up to 16). */
  highFanout: boolean;
  /** Parsed count when the user named a number (clamped 1–16). */
  requestedCount?: number;
}>;

export type ExploreConcurrencyBudget = Readonly<{
  /** Mechanical parallel cap for this turn. */
  effectiveMax: number;
  /** Prompt guidance for how many to issue (0 = prefer no subagents). */
  suggested: number;
  mode: "default" | "ultra" | "user" | "fast";
  /** Config / absolute ceiling used for this resolution. */
  hardCap: number;
  /** Adaptive lane when signal-based resolution is used. */
  lane?: ExploreLane;
  reason?: string;
}>;

/**
 * Detect explicit user requests for large explore fan-out.
 * Only high fan-out (≥5 named workers, or “max/as many”) unlocks up to 16 when not ultra.
 */
export function detectUserExploreFanoutRequest(text: string): ExploreFanoutRequest {
  const raw = text.trim();
  if (raw.length === 0) {
    return { highFanout: false };
  }

  const countPatterns: readonly RegExp[] = [
    /(\d{1,2})\s*(?:个)?\s*(?:explore|sub[- ]?agents?|workers?|子代理|探索(?:子代理)?)/i,
    /(?:explore|sub[- ]?agents?|workers?|子代理)\s*(?:x|×|\*)?\s*(\d{1,2})/i,
    /(?:用|调用|开|跑|使用|spawn|use|run|launch|fan[- ]?out|parallel|并发)\s*(\d{1,2})\s*(?:个)?\s*(?:explore|sub[- ]?agents?|workers?|子代理)?/i,
    /(?:max[_-]?concurrency|并发(?:上限|数)?|并行(?:度|数)?)\s*[:=]?\s*(\d{1,2})/i,
  ];

  for (const pattern of countPatterns) {
    const match = raw.match(pattern);
    if (!match?.[1]) continue;
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n < 1) continue;
    const requestedCount = Math.min(MAX_EXPLORE_CONCURRENCY, n);
    // 1–4 is within the default band; only ≥5 (or 16) is a high-fanout unlock.
    if (requestedCount >= 5) {
      return { highFanout: true, requestedCount };
    }
  }

  if (
    /(?:as many (?:as possible )?|maximum|max(?:imum)?)\s+(?:explore|sub[- ]?agents?|workers?|fan[- ]?out)/i
      .test(raw)
    || /(?:最大|开满|尽量多|尽可能多).{0,12}(?:explore|subagent|子代理|并发|并行)/i.test(raw)
    || /(?:explore|subagent|子代理|并发|并行).{0,12}(?:最大|开满|尽量多|尽可能多)/i.test(raw)
  ) {
    return { highFanout: true, requestedCount: MAX_EXPLORE_CONCURRENCY };
  }

  return { highFanout: false };
}

/**
 * Resolve concurrent explore budget for the primary agent.
 *
 * Adaptive lanes (preferred when `signal` provided):
 * - fast (0) / standard (2–4) / deep (4–8) / explicit_high (≤16)
 *
 * Legacy path (no signal):
 * - user high fan-out → up to 16
 * - thinking=ultra → deep ceiling (not forced spawn on single-file)
 * - otherwise → at most 4
 */
export function resolveExploreConcurrencyBudget(
  input: Readonly<{
    thinkingLevel: ThinkingLevel;
    configMax: number;
    userRequest: ExploreFanoutRequest;
    scale?: ExploreScaleEstimate;
    /** When set, use evidence-driven lane selection. */
    signal?: Omit<TaskExploreSignal, "thinkingLevel" | "userRequest" | "scale">;
  }>,
): ExploreConcurrencyBudget {
  const hardCap = Math.min(
    Math.max(1, Math.floor(input.configMax)),
    MAX_EXPLORE_CONCURRENCY,
  );

  if (input.signal) {
    const decision = selectExploreLane({
      ...input.signal,
      thinkingLevel: input.thinkingLevel,
      userRequest: input.userRequest,
      scale: input.scale,
    });
    return {
      effectiveMax: Math.min(hardCap, decision.effectiveMax),
      suggested: decision.suggested === 0 ? 0 : Math.min(hardCap, decision.suggested),
      mode: decision.mode,
      hardCap,
      lane: decision.lane,
      reason: decision.reason,
    };
  }

  const scaleSuggest = input.scale
    ? suggestExploreConcurrency(input.scale, hardCap)
    : Math.min(DEFAULT_EXPLORE_ACTIVE_MAX, hardCap);

  if (input.userRequest.highFanout) {
    const requested = input.userRequest.requestedCount ?? hardCap;
    const effectiveMax = Math.min(hardCap, Math.max(DEFAULT_EXPLORE_ACTIVE_MAX, requested));
    const suggested = Math.min(effectiveMax, Math.max(requested, scaleSuggest));
    return {
      effectiveMax,
      suggested: Math.max(1, suggested),
      mode: "user",
      hardCap,
      lane: "explicit_high",
      reason: "user explicitly requested high fan-out",
    };
  }

  if (input.thinkingLevel === "ultra") {
    // Deep lane ceiling: raise max, suggest scale-aware count (not always 8+).
    const effectiveMax = hardCap;
    const suggested = Math.min(
      effectiveMax,
      Math.max(DEFAULT_EXPLORE_ACTIVE_MAX, Math.min(ULTRA_EXPLORE_ACTIVE_MIN, scaleSuggest)),
    );
    return {
      effectiveMax,
      suggested: Math.max(1, suggested),
      mode: "ultra",
      hardCap,
      lane: "deep",
      reason: "ultra thinking elevates deep lane ceiling",
    };
  }

  const effectiveMax = Math.min(DEFAULT_EXPLORE_ACTIVE_MAX, hardCap);
  return {
    effectiveMax,
    suggested: Math.max(1, Math.min(effectiveMax, scaleSuggest)),
    mode: "default",
    hardCap,
    lane: "standard",
    reason: "standard multi-file exploration",
  };
}
