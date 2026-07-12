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

/** Levels the UI may offer for the active model. */
export function availableThinkingLevels(model: ProviderModelConfig | undefined): readonly ThinkingLevel[] {
  if (!model) return THINKING_LEVELS;
  const mapped = THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== undefined);
  if (mapped.length > 0) return mapped;
  if (model.reasoning) return THINKING_LEVELS;
  return ["off"];
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
  return level;
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
