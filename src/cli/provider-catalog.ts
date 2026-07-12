export type ProviderPreset = Readonly<{
  id: string;
  label: string;
  kind: string;
  baseUrl?: string;
  apiKeyEnv: string;
  defaultModel: string;
  sampleModels: readonly string[];
  /** When true, /connect prompts for provider id + base URL. */
  custom?: boolean;
}>;

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
    sampleModels: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4.1",
    sampleModels: ["gpt-4.1", "gpt-4o", "o4-mini"],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-20250514",
    sampleModels: [
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-haiku-4-20250414",
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultModel: "openrouter/auto",
    sampleModels: ["openrouter/auto", "anthropic/claude-sonnet-4", "openai/gpt-4.1"],
  },
  {
    id: "google",
    label: "Google / Gemini",
    // OpenAI-compat surface — runtime LLM client is OpenAI/Anthropic only.
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
    sampleModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    kind: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
    sampleModels: [],
    custom: true,
  },
];

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function providerPresetChoices(): readonly string[] {
  return PROVIDER_PRESETS.map((preset) => `${preset.label} (${preset.id})`);
}

export function presetIdFromChoice(choice: string): string | undefined {
  const match = choice.match(/\(([^)]+)\)\s*$/);
  if (match?.[1]) return match[1];
  return PROVIDER_PRESETS.find((preset) => preset.label === choice || preset.id === choice)?.id;
}
