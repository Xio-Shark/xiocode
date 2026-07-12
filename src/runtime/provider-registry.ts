import type { XioRuntimeConfig } from "../cli/config-parser.ts";
import type { ExtensionHost } from "./extension-host.ts";
import type { ModelInfo, ProviderRegistration } from "./types.ts";

export function resolveDefaultModel(config: XioRuntimeConfig): ModelInfo {
  const provider = config.general.defaultProvider;
  const model = config.general.defaultModel;
  if (!provider || !model) {
    const first = Object.values(config.providers)[0];
    if (!first?.model) throw new Error("no default provider/model configured");
    return { provider: first.name, id: first.model, name: first.model, api: providerApi(first.kind) };
  }
  const configured = config.providers[provider];
  return {
    provider,
    id: model,
    name: model,
    api: configured ? providerApi(configured.kind) : "openai-completions",
  };
}

export function registerConfiguredProviders(host: ExtensionHost, config: XioRuntimeConfig): void {
  for (const provider of Object.values(config.providers)) {
    if (!provider.model) continue;
    const registration: ProviderRegistration = {
      name: provider.name,
      api: providerApi(provider.kind),
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKeyEnv ? `$${provider.apiKeyEnv}` : undefined,
      authHeader: true,
      thinkingDisplay: provider.thinkingDisplay,
      models: [{
        id: provider.model,
        name: provider.model,
        reasoning: provider.reasoning ?? false,
        thinkingLevelMap: provider.thinkingLevelMap,
        input: provider.input ? [...provider.input] : ["text"],
        contextWindow: provider.contextWindow ?? 128_000,
        maxTokens: provider.maxTokens ?? 8192,
        headers: provider.headers,
        compat: provider.compat,
      }],
    };
    host.registerProvider(provider.name, registration);
  }
}

export function providerApi(kind: string): string {
  if (kind === "anthropic") return "anthropic-messages";
  if (kind === "mistral") return "mistral-conversations";
  if (kind === "google") return "google-generative-ai";
  if (kind === "google-vertex") return "google-vertex";
  if (kind === "bedrock") return "bedrock-converse-stream";
  return "openai-completions";
}
