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

export type ResolveExploreConfigOptions = Readonly<{
  /**
   * Force-enable even when `[explore] enabled = false`.
   * Used for thinking=ultra auto multi-explore.
   */
  forceEnable?: boolean;
  /**
   * Fallback model when `explore.model` is unset (`provider/model` or bare id).
   * Typically the session primary model so ultra works without config.
   */
  fallbackModel?: string;
}>;

/**
 * Resolve explore worker identity + budgets.
 * Returns undefined when off and not force-enabled, or when no model identity is available.
 */
export function resolveExploreConfig(
  explore: XioExploreConfig,
  general: XioGeneralConfig,
  options: ResolveExploreConfigOptions = {},
): ResolvedExploreConfig | undefined {
  const enabled = explore.enabled || options.forceEnable === true;
  if (!enabled) {
    return undefined;
  }

  const modelField = explore.model?.trim()
    || options.fallbackModel?.trim()
    || general.defaultModel?.trim();
  if (!modelField) {
    return undefined;
  }

  const defaultProvider = general.defaultProvider?.trim();
  let identity: Readonly<{ provider: string; model: string }>;
  try {
    if (explore.provider?.trim()) {
      identity = parseProviderModelRef(
        modelField.includes("/") ? modelField : `${explore.provider.trim()}/${modelField}`,
      );
    } else {
      identity = parseProviderModelRef(modelField, defaultProvider);
    }
  } catch {
    return undefined;
  }

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

/** Prefer explicit explore.model, then session primary, then general default. */
export function exploreFallbackModelRef(input: Readonly<{
  exploreModel?: string;
  sessionProvider?: string;
  sessionModel?: string;
  defaultProvider?: string;
  defaultModel?: string;
}>): string | undefined {
  if (input.exploreModel?.trim()) return input.exploreModel.trim();
  if (input.sessionProvider?.trim() && input.sessionModel?.trim()) {
    return `${input.sessionProvider.trim()}/${input.sessionModel.trim()}`;
  }
  if (input.defaultModel?.trim()) {
    if (input.defaultModel.includes("/")) return input.defaultModel.trim();
    if (input.defaultProvider?.trim()) {
      return `${input.defaultProvider.trim()}/${input.defaultModel.trim()}`;
    }
    return input.defaultModel.trim();
  }
  return undefined;
}
