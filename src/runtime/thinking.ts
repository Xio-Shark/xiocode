import type {
  ProviderModelConfig,
  ProviderRegistration,
  ThinkingDisplay,
  ThinkingLevel,
} from "./types.ts";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

const ANTHROPIC_BUDGETS: Readonly<Record<Exclude<ThinkingLevel, "off">, number>> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 32_768,
  max: 65_536,
  ultra: 128_000,
};

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function parseThinkingLevel(value: string): ThinkingLevel | undefined {
  const trimmed = value.trim().toLowerCase();
  return isThinkingLevel(trimmed) ? trimmed : undefined;
}

export function thinkingStatusLabel(level: ThinkingLevel): string {
  return `think:${level}`;
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
 * - Explicit `thinkingLevelMap` keys still restrict the menu (opt-in API mapping).
 * - Otherwise every model gets the full ladder so `/effort` and Tab cycling always work.
 * - Product levels (`max` / `ultra`) stay in the UI; wire encoding is separate
 *   (`openAiReasoningEffort`) so gateways never see unknown product-only tokens
 *   unless the user mapped them explicitly.
 */
export function availableThinkingLevels(model: ProviderModelConfig | undefined): readonly ThinkingLevel[] {
  if (!model?.thinkingLevelMap) return THINKING_LEVELS;
  const mapped = THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== undefined);
  return mapped.length > 0 ? mapped : THINKING_LEVELS;
}

/**
 * Default OpenAI-compat `reasoning_effort` when no thinking_level_map entry.
 *
 * Product UI keeps the full ladder (incl. max/ultra) for status + explore policy.
 * Wire encoding follows each provider's documented enum:
 *
 * DeepSeek V4 (official docs):
 *   - Possible values: high | max
 *   - Compatibility: low/medium → high; xhigh → max
 *   - Claude Code / Codex "max"/"ultra" are client effort menus; on DeepSeek both map to max
 *     (ultra is not a DeepSeek API token — same pattern as Claude Code ultracode ≠ extra API enum)
 *
 * OpenAI-style: top wire tier is xhigh; product max/ultra → xhigh.
 */
const DEEPSEEK_REASONING_EFFORT: Readonly<Record<Exclude<ThinkingLevel, "off">, string>> = {
  // Official: low/medium map to high; minimal treated the same for the short ladder.
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  // Official: xhigh → max; max is a first-class value; ultra is client-only → max.
  xhigh: "max",
  max: "max",
  ultra: "max",
};

const OPENAI_REASONING_EFFORT: Readonly<Record<Exclude<ThinkingLevel, "off">, string>> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
  ultra: "xhigh",
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
