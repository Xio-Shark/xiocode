import type { XioProviderConfig } from "./config-parser.ts";

export type EnvSetupResult = Readonly<{
  provider: string;
  sourceEnv: string;
  targetEnv: string;
  applied: boolean;
}>;

const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  google: "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_CLOUD_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function setupProviderEnv(
  providers: Readonly<Record<string, XioProviderConfig>>,
  env: NodeJS.ProcessEnv = process.env,
): readonly EnvSetupResult[] {
  return Object.values(providers)
    .filter((provider) => provider.apiKeyEnv !== undefined)
    .map((provider) => setupOneProvider(provider, env));
}

export function targetApiKeyEnv(provider: XioProviderConfig): string {
  return PROVIDER_API_KEY_ENV[provider.name] ?? PROVIDER_API_KEY_ENV[provider.kind] ?? `${normalizeEnvName(provider.name)}_API_KEY`;
}

function setupOneProvider(provider: XioProviderConfig, env: NodeJS.ProcessEnv): EnvSetupResult {
  const sourceEnv = provider.apiKeyEnv ?? targetApiKeyEnv(provider);
  const targetEnv = targetApiKeyEnv(provider);
  const value = env[sourceEnv];
  if (value !== undefined && value.length > 0) {
    env[targetEnv] = value;
  }
  return {
    provider: provider.name,
    sourceEnv,
    targetEnv,
    applied: value !== undefined && value.length > 0,
  };
}

function normalizeEnvName(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}
