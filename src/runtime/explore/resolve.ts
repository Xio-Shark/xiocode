import type { XioExploreConfig, XioGeneralConfig } from "../../cli/config-parser.ts";

import type { ResolvedExploreConfig } from "./types.ts";

/**
 * Parse `provider/model` or bare model id (needs defaultProvider).
 * Multi-segment ids (e.g. openrouter/org/model) keep first segment as provider.
 */
export function parseProviderModelRef(
  ref: string,
  defaultProvider?: string,
): Readonly<{ provider: string; model: string }> {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new Error("model ref must be non-empty");
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    if (!defaultProvider || defaultProvider.trim().length === 0) {
      throw new Error("model ref needs provider/model or a default provider");
    }
    return { provider: defaultProvider.trim(), model: trimmed };
  }
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (provider.length === 0 || model.length === 0) {
    throw new Error(`invalid model ref: ${ref}`);
  }
  return { provider, model };
}

/** Returns undefined when explore is off or not fully configured. */
export function resolveExploreConfig(
  explore: XioExploreConfig,
  general: XioGeneralConfig,
): ResolvedExploreConfig | undefined {
  if (!explore.enabled) {
    return undefined;
  }
  const modelField = explore.model?.trim();
  if (!modelField) {
    return undefined;
  }
  const identity = explore.provider?.trim()
    ? parseProviderModelRef(
      modelField.includes("/") ? modelField : `${explore.provider.trim()}/${modelField}`,
    )
    : parseProviderModelRef(modelField, general.defaultProvider);

  return {
    provider: identity.provider,
    model: identity.model,
    maxTurns: explore.maxTurns,
    timeoutMs: explore.timeoutMs,
    maxConcurrency: explore.maxConcurrency,
    maxOutputChars: explore.maxOutputChars,
    allowBash: explore.allowBash,
    ...(explore.partitionHint ? { partitionHint: explore.partitionHint } : {}),
  };
}
