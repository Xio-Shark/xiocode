import { upsertGeneralDefaults } from "../../../src/cli/config-mutate.ts";
import { parseXioConfig } from "../../../src/cli/config-parser.ts";
import { providerApi } from "../../../src/runtime/provider-registry.ts";
import { targetApiKeyEnv } from "../../../src/cli/env-setup.ts";

import type { XioProviderConfig, XioThinkingLevel } from "../../../src/cli/config-parser.ts";

export type PinnedModelRef = Readonly<{
  provider: string;
  model: string;
}>;

export type InferenceSettingsIdentity = Readonly<{
  provider_api: string;
  thinking_level: XioThinkingLevel | "unset";
  thinking_supported: boolean | "unknown";
  parallel_tool_calls: boolean;
  temperature: "provider-default";
  seed: "unsupported";
  max_tokens: "provider-config" | "unsupported";
}>;

export type PinnedEvalIdentity = Readonly<{
  provider: string;
  exact_model_id: string;
  provider_api: string;
  api_key_env: string;
  inference_settings: InferenceSettingsIdentity;
}>;

/** Parse `provider/model-id` (model id may contain `/`). */
export function parseModelRef(value: string): PinnedModelRef {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash >= value.length - 1) {
    throw new Error(`--model must be provider/model (got ${JSON.stringify(value)})`);
  }
  return {
    provider: value.slice(0, slash),
    model: value.slice(slash + 1),
  };
}

export function formatModelRef(ref: PinnedModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

export function resolvePinnedIdentity(
  configContent: string,
  modelRef?: string,
): PinnedEvalIdentity {
  const parsed = parseXioConfig(configContent);
  const ref = modelRef
    ? parseModelRef(modelRef)
    : resolveDefaultRef(parsed.xio.general.defaultProvider, parsed.xio.general.defaultModel, parsed.xio.providers);
  const provider = parsed.xio.providers[ref.provider];
  if (!provider) {
    throw new Error(`provider ${JSON.stringify(ref.provider)} is not configured in config.toml`);
  }
  return buildIdentity(ref, provider, parsed.xio.general.defaultThinkingLevel);
}

export function pinModelInConfig(configContent: string, identity: PinnedEvalIdentity): string {
  let next = upsertGeneralDefaults(configContent, {
    defaultProvider: identity.provider,
    defaultModel: identity.exact_model_id,
  });
  // Keep provider.model aligned with the pinned exact id for session registration.
  const modelLine = `model = ${tomlString(identity.exact_model_id)}`;
  const sectionRe = new RegExp(
    `(\\[providers\\.${escapeRegExp(identity.provider)}\\][\\s\\S]*?)(?=\\n\\[|$)`,
  );
  const match = next.match(sectionRe);
  if (!match) {
    return next;
  }
  const body = match[1] ?? "";
  const keyRe = /^(\s*model\s*=\s*).*$/m;
  const updated = keyRe.test(body)
    ? body.replace(keyRe, `$1${tomlString(identity.exact_model_id)}`)
    : `${body.replace(/\s*$/, "")}\n${modelLine}\n`;
  return next.replace(sectionRe, () => updated);
}

export function buildInferenceSettings(
  provider: XioProviderConfig,
  thinkingLevel?: XioThinkingLevel,
): InferenceSettingsIdentity {
  return {
    provider_api: providerApi(provider.kind),
    thinking_level: thinkingLevel ?? "unset",
    thinking_supported: provider.reasoning === true
      ? true
      : provider.reasoning === false
      ? false
      : "unknown",
    parallel_tool_calls: provider.parallelToolCalls ?? true,
    temperature: "provider-default",
    seed: "unsupported",
    max_tokens: provider.maxTokens !== undefined ? "provider-config" : "unsupported",
  };
}

function buildIdentity(
  ref: PinnedModelRef,
  provider: XioProviderConfig,
  thinkingLevel?: XioThinkingLevel,
): PinnedEvalIdentity {
  return {
    provider: ref.provider,
    exact_model_id: ref.model,
    provider_api: providerApi(provider.kind),
    api_key_env: provider.apiKeyEnv ?? targetApiKeyEnv(provider),
    inference_settings: buildInferenceSettings(provider, thinkingLevel),
  };
}

function resolveDefaultRef(
  defaultProvider: string | undefined,
  defaultModel: string | undefined,
  providers: Readonly<Record<string, XioProviderConfig>>,
): PinnedModelRef {
  if (defaultProvider && defaultModel) {
    return { provider: defaultProvider, model: defaultModel };
  }
  const first = Object.values(providers)[0];
  if (!first?.model) {
    throw new Error("real eval requires --model provider/model or configured default_provider/default_model");
  }
  return { provider: first.name, model: first.model };
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
