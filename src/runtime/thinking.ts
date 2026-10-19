import { hasMessage, t } from "../i18n/messages.ts";
import type {
  ProviderModelConfig,
  ProviderRegistration,
  ThinkingDisplay,
  ThinkingLevel,
} from "./types.ts";

/**
 * Product ladder — the four levels a session can be on, same set DSH offers.
 *
 * Wire encoding stays separate (`openAiReasoningEffort` / `anthropicThinkingConfig`)
 * so a gateway never receives a level its API does not name.
 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "low",
  "high",
  "max",
] as const;

/**
 * Older product names, still accepted from config files and scripts.
 *
 * They resolve to the nearest surviving level on read instead of failing a
 * session start; nothing in the UI offers them anymore.
 */
const LEGACY_THINKING_LEVELS: Readonly<Record<string, ThinkingLevel>> = {
  minimal: "low",
  medium: "high",
  xhigh: "max",
  ultra: "max",
};

const ANTHROPIC_BUDGETS: Readonly<Record<Exclude<ThinkingLevel, "off">, number>> = {
  low: 2_048,
  high: 16_384,
  max: 65_536,
};

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Canonical level for user input; legacy names come back as their surviving neighbour. */
export function parseThinkingLevel(value: string): ThinkingLevel | undefined {
  const trimmed = value.trim().toLowerCase();
  if (isThinkingLevel(trimmed)) return trimmed;
  return LEGACY_THINKING_LEVELS[trimmed];
}

export function thinkingStatusLabel(level: ThinkingLevel): string {
  const key = `think.${level}`;
  return t("status.think", { level: hasMessage(key) ? t(key) : level });
}

export function findProviderModel(
  registration: ProviderRegistration | undefined,
  modelId: string,
): ProviderModelConfig | undefined {
  return registration?.models.find((model) => model.id === modelId);
}

/**
 * Levels the UI may offer for the active model.
 *
 * - An explicit `thinkingLevelMap` restricts the menu to the levels it names
 *   (the model declares what it supports, the way DSH adapters do).
 * - Otherwise every model gets the full ladder so `/effort` and Tab cycling always work.
 */
export function availableThinkingLevels(model: ProviderModelConfig | undefined): readonly ThinkingLevel[] {
  if (!model?.thinkingLevelMap) return THINKING_LEVELS;
  const mapped = THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== undefined);
  return mapped.length > 0 ? mapped : THINKING_LEVELS;
}

/**
 * Default OpenAI-compat `reasoning_effort` when no thinking_level_map entry.
 *
 * DeepSeek names `low | high | max` on the wire (probed against the configured
 * gateways 2026-10-19: all four product levels are accepted); `off` is expressed
 * by the thinking toggle, never as an effort value.
 *
 * Other OpenAI-style gateways stop at `xhigh`, so product `max` is its top tier.
 */
const DEEPSEEK_REASONING_EFFORT: Readonly<Record<Exclude<ThinkingLevel, "off">, string>> = {
  low: "low",
  high: "high",
  max: "max",
};

const OPENAI_REASONING_EFFORT: Readonly<Record<Exclude<ThinkingLevel, "off">, string>> = {
  low: "low",
  high: "high",
  max: "xhigh",
};

export function isDeepSeekReasoningModel(model: ProviderModelConfig | undefined): boolean {
  const id = (model?.id ?? "").toLowerCase();
  const name = (model?.name ?? "").toLowerCase();
  return id.includes("deepseek") || name.includes("deepseek");
}

/**
 * DeepSeek thinking toggle (OpenAI-compat body field `thinking`).
 * Docs require `thinking: { type: "enabled" }` alongside reasoning_effort for thinking mode.
 * Returns undefined for non-DeepSeek models (leave body alone).
 */
export function deepseekThinkingToggle(
  level: ThinkingLevel | undefined,
  model: ProviderModelConfig | undefined,
): Readonly<{ type: "enabled" | "disabled" }> | undefined {
  if (!isDeepSeekReasoningModel(model)) return undefined;
  if (!level || level === "off") return { type: "disabled" };
  // Explicit map to empty/null means "omit effort" — still leave thinking control alone unless off.
  const mapped = model?.thinkingLevelMap?.[level];
  if (mapped === null || mapped === "") return { type: "disabled" };
  return { type: "enabled" };
}

export function cycleThinkingLevel(
  current: ThinkingLevel,
  available: readonly ThinkingLevel[],
): ThinkingLevel {
  if (available.length === 0) return current;
  const index = available.indexOf(current);
  const next = index < 0 ? 0 : (index + 1) % available.length;
  return available[next] ?? current;
}

export function clampThinkingLevel(
  level: ThinkingLevel,
  available: readonly ThinkingLevel[],
): ThinkingLevel {
  if (available.includes(level)) return level;
  return available[0] ?? "off";
}

/** OpenAI-compat wire value for reasoning_effort; undefined means omit. */
export function openAiReasoningEffort(
  level: ThinkingLevel | undefined,
  model: ProviderModelConfig | undefined,
): string | undefined {
  if (!level || level === "off") return undefined;
  const mapped = model?.thinkingLevelMap?.[level];
  if (mapped === null || mapped === "") return undefined;
  if (typeof mapped === "string") return mapped;
  // No explicit map entry: encode product levels to gateway-safe defaults.
  // (Map presence with missing key also lands here so partial maps stay usable.)
  const table = isDeepSeekReasoningModel(model) ? DEEPSEEK_REASONING_EFFORT : OPENAI_REASONING_EFFORT;
  return table[level];
}

export type AnthropicThinkingWire = Readonly<{
  type: "enabled";
  budget_tokens: number;
  display?: ThinkingDisplay;
}>;

/** Anthropic thinking block; undefined means omit. */
export function anthropicThinkingConfig(
  level: ThinkingLevel | undefined,
  model: ProviderModelConfig | undefined,
  display?: ThinkingDisplay,
): AnthropicThinkingWire | undefined {
  if (!level || level === "off") return undefined;
  const mapped = model?.thinkingLevelMap?.[level];
  if (mapped === null || mapped === "") return undefined;
  let budget = ANTHROPIC_BUDGETS[level];
  if (typeof mapped === "string") {
    const parsed = Number(mapped);
    if (Number.isFinite(parsed) && parsed > 0) {
      budget = Math.floor(parsed);
    }
  }
  return display
    ? { type: "enabled", budget_tokens: budget, display }
    : { type: "enabled", budget_tokens: budget };
}

export function thinkingLevelChoices(levels: readonly ThinkingLevel[]): readonly {
  label: string;
  value: string;
}[] {
  return levels.map((level) => ({
    label: level === "off" ? "off — no reasoning" : level,
    value: level,
  }));
}
