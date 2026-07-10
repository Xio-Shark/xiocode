import type { TokenUsage } from "./types.ts";

export function normalizeProviderUsage(api: string, raw: unknown): TokenUsage {
  const root = asRecord(raw);
  const usage = asRecord(root.usage);
  if (Object.keys(usage).length === 0) {
    return emptyTokenUsage();
  }
  return api === "anthropic-messages"
    ? normalizeAnthropicUsage(usage)
    : normalizeOpenAiUsage(usage);
}

export function sumTokenUsage(values: readonly TokenUsage[]): TokenUsage {
  if (values.length === 0) {
    return emptyTokenUsage();
  }
  return {
    inputTokens: sumComplete(values.map((value) => value.inputTokens)),
    outputTokens: sumComplete(values.map((value) => value.outputTokens)),
    cacheTokens: sumComplete(values.map((value) => value.cacheTokens)),
    reasoningTokens: sumComplete(values.map((value) => value.reasoningTokens)),
  };
}

export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheTokens: null,
    reasoningTokens: null,
  };
}

export function decodeProviderUsageEvent(value: unknown): TokenUsage {
  const event = asRecord(value);
  const usage = asRecord(event.usage);
  if (Object.keys(usage).length === 0) {
    throw new Error("provider_response event is missing usage");
  }
  return {
    inputTokens: nullableNumber(usage.inputTokens, "inputTokens"),
    outputTokens: nullableNumber(usage.outputTokens, "outputTokens"),
    cacheTokens: nullableNumber(usage.cacheTokens, "cacheTokens"),
    reasoningTokens: nullableNumber(usage.reasoningTokens, "reasoningTokens"),
  };
}

function normalizeOpenAiUsage(usage: Record<string, unknown>): TokenUsage {
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const completionDetails = asRecord(usage.completion_tokens_details);
  return {
    inputTokens: numberOrNull(usage.prompt_tokens ?? usage.input_tokens),
    outputTokens: numberOrNull(usage.completion_tokens ?? usage.output_tokens),
    cacheTokens: numberOrNull(promptDetails.cached_tokens ?? usage.cached_tokens),
    reasoningTokens: numberOrNull(completionDetails.reasoning_tokens ?? usage.reasoning_tokens),
  };
}

function normalizeAnthropicUsage(usage: Record<string, unknown>): TokenUsage {
  const cacheTokens = sumComplete([
    optionalNumberOrZero(usage.cache_read_input_tokens),
    optionalNumberOrZero(usage.cache_creation_input_tokens),
  ]);
  const uncachedInput = numberOrNull(usage.input_tokens);
  return {
    inputTokens: uncachedInput === null || cacheTokens === null ? null : uncachedInput + cacheTokens,
    outputTokens: numberOrNull(usage.output_tokens),
    cacheTokens,
    reasoningTokens: numberOrNull(usage.reasoning_tokens),
  };
}

function sumComplete(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function optionalNumberOrZero(value: unknown): number | null {
  return value === undefined ? 0 : numberOrNull(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  throw new Error(`invalid provider usage field: ${field}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
