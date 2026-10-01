import type { XioProviderConfig, XioRuntimeConfig } from "../cli/config-parser.ts";
import type { ExtensionHost } from "./extension-host.ts";
import type { ModelInfo, ProviderRegistration } from "./types.ts";

export function resolveDefaultModel(config: XioRuntimeConfig): ModelInfo {
  const provider = config.general.defaultProvider;
  const model = config.general.defaultModel;
  if (provider && model && config.providers[provider]?.model) {
    const configured = config.providers[provider]!;
    return {
      provider,
      id: model,
      name: model,
      api: providerApi(configured.kind),
    };
  }
  const first = Object.values(config.providers).find((p) => p.model);
  if (first?.model) {
    return {
      provider: first.name,
      id: first.model,
      name: first.model,
      api: providerApi(first.kind),
    };
  }
  if (provider && model) {
    const configured = config.providers[provider];
    return {
      provider,
      id: model,
      name: model,
      api: configured ? providerApi(configured.kind) : "openai-completions",
    };
  }
  throw new Error("no default provider/model configured");
}

export function registerConfiguredProviders(host: ExtensionHost, config: XioRuntimeConfig): void {
  for (const provider of Object.values(config.providers)) {
    if (!provider.model) continue;
    host.registerProvider(provider.name, providerRegistration(provider));
  }
}

/**
 * The one mapping from a `[providers.*]` entry to a host registration — used by
 * startup, the xio extension and /connect, so a new provider field is added once.
 */
export function providerRegistration(provider: XioProviderConfig, extraModels: readonly string[] = []): ProviderRegistration {
  const modelIds = [...new Set([...(provider.model ? [provider.model] : []), ...extraModels].filter((id) => id.length > 0))];
  return {
    name: provider.name,
    api: providerApi(provider.kind),
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKeyEnv ? `$${provider.apiKeyEnv}` : undefined,
    authHeader: true,
    thinkingDisplay: provider.thinkingDisplay,
    toolChoice: provider.toolChoice,
    toolChoiceScope: provider.toolChoiceScope,
    sessionHeader: provider.sessionHeader ?? defaultSessionHeader(provider.baseUrl),
    models: modelIds.map((id) => ({
      id,
      name: id,
      // Default true so effort UI works without per-provider flags; set reasoning = false for non-reasoning models.
      reasoning: provider.reasoning ?? true,
      thinkingLevelMap: provider.thinkingLevelMap,
      input: provider.input ? [...provider.input] : ["text"],
      contextWindow: provider.contextWindow ?? 128_000,
      maxTokens: provider.maxTokens ?? 8192,
      headers: provider.headers,
      compat: provider.compat,
    })),
  };
}

/**
 * OpenCode Zen / Go route and cache by conversation and ask every client to send
 * a stable id per conversation in `x-opencode-session`
 * (https://opencode.ai/docs/go/). Other endpoints get none unless configured.
 */
export function defaultSessionHeader(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
  return host === "opencode.ai" || host.endsWith(".opencode.ai") ? "x-opencode-session" : undefined;
}

export function providerApi(kind: string): string {
  if (kind === "anthropic") return "anthropic-messages";
  if (kind === "mistral") return "mistral-conversations";
  if (kind === "google") return "google-generative-ai";
  if (kind === "google-vertex") return "google-vertex";
  if (kind === "bedrock") return "bedrock-converse-stream";
  return "openai-completions";
}
