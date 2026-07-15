import { readFile, writeFile } from "node:fs/promises";

import {
  applyCredentialsToEnv,
  loadCredentials,
  saveProviderCredential,
} from "../cli/credentials.ts";
import { mutateConnectConfig } from "../cli/config-mutate.ts";
import { resolveConfigPath } from "../cli/ensure-config.ts";
import {
  PROVIDER_PRESETS,
  findProviderPreset,
  type ProviderPreset,
} from "../cli/provider-catalog.ts";
import { targetApiKeyEnv } from "../cli/env-setup.ts";
import { discoverModels, probeApiKey } from "./providers/discover.ts";
import { providerApi } from "./provider-registry.ts";

import type { InteractiveIO } from "./interactive-io.ts";
import type { ExtensionHost } from "./extension-host.ts";
import type { ModelInfo, ProviderRegistration } from "./types.ts";
import type { SessionUiSink } from "./session-ui.ts";
import type { XioProviderConfig, XioRuntimeConfig } from "../cli/config-parser.ts";

export type ConnectCommandOptions = Readonly<{
  host: ExtensionHost;
  interactive: InteractiveIO;
  runtimeConfig: XioRuntimeConfig;
  env: NodeJS.ProcessEnv;
  sink: SessionUiSink;
  getModel: () => ModelInfo;
  setModel: (model: ModelInfo) => Promise<void>;
  fetchImpl?: typeof fetch;
}>;

export function registerConnectCommands(options: ConnectCommandOptions): void {
  options.host.registerCommand("connect", {
    description: "Connect a model provider with an API key.",
    handler: async () => runConnect(options),
  });
  options.host.registerCommand("model", {
    description: "Switch the current session model among connected providers.",
    handler: async () => runModel(options),
  });
}

async function runConnect(options: ConnectCommandOptions): Promise<string> {
  const choice = await options.interactive.select(
    "Select a provider",
    PROVIDER_PRESETS.map((preset) => ({
      label: `${preset.label} (${preset.id})`,
      value: preset.id,
    })),
  );
  if (!choice) return "connect cancelled";

  const preset = findProviderPreset(choice);
  if (!preset) return `unknown provider: ${choice}`;

  const resolved = await resolvePresetForConnect(preset, options.interactive);
  if (!resolved) return "connect cancelled";

  const apiKey = await options.interactive.prompt("API key", { secret: true });
  if (!apiKey) return "connect cancelled";

  const probe = await probeApiKey({
    kind: resolved.kind,
    baseUrl: resolved.baseUrl,
    apiKey,
    catalogModels: resolved.sampleModels,
    fetchImpl: options.fetchImpl,
  });
  if (!probe.ok) {
    throw new Error(probe.error ?? "API key validation failed");
  }

  let modelId = resolved.defaultModel;
  if (probe.models.length > 0) {
    const picked = await options.interactive.select(
      "Select default model",
      [
        ...probe.models.slice(0, 40).map((id) => ({ label: id, value: id })),
        { label: "Enter model id manually…", value: "__manual__" },
      ],
    );
    if (!picked) return "connect cancelled";
    if (picked === "__manual__") {
      const manual = await options.interactive.prompt("Model id");
      if (!manual) return "connect cancelled";
      modelId = manual;
    } else {
      modelId = picked;
    }
  } else {
    const manual = await options.interactive.prompt(`Model id (default: ${resolved.defaultModel})`);
    if (manual) modelId = manual;
  }

  await persistConnect({
    options,
    providerName: resolved.id,
    kind: resolved.kind,
    baseUrl: resolved.baseUrl,
    apiKeyEnv: resolved.apiKeyEnv,
    apiKey,
    modelId,
    models: uniqueModels([modelId, ...probe.models, ...resolved.sampleModels]),
  });

  await options.setModel({
    provider: resolved.id,
    id: modelId,
    name: modelId,
    api: providerApi(resolved.kind),
  });
  options.sink.setStatus?.("model", `${resolved.id}/${modelId}`);
  // Return value is shown by TUI/REPL — avoid duplicate sink.notify.
  return `connected ${resolved.id}/${modelId} (key saved to credentials, not config.toml)`;
}

async function runModel(options: ConnectCommandOptions): Promise<string> {
  const connected = await listConnectedProviders(options);
  if (connected.length === 0) {
    throw new Error("No connected providers. Run /connect first.");
  }

  const entries: Array<{ label: string; value: string; provider: string; model: string }> = [];
  for (const provider of connected) {
    const models = await collectModelsForProvider(provider, options);
    for (const model of models) {
      entries.push({
        label: `${provider.name}/${model}`,
        value: `${provider.name}::${model}`,
        provider: provider.name,
        model,
      });
    }
  }
  entries.push({ label: "Enter model id manually…", value: "__manual__", provider: "", model: "" });

  const picked = await options.interactive.select("Select model", entries.map((entry) => ({
    label: entry.label,
    value: entry.value,
  })));
  if (!picked) return "model cancelled";

  let providerName: string;
  let modelId: string;
  if (picked === "__manual__") {
    const providerChoice = await options.interactive.select(
      "Provider for manual model id",
      connected.map((provider) => ({ label: provider.name, value: provider.name })),
    );
    if (!providerChoice) return "model cancelled";
    const manual = await options.interactive.prompt("Model id");
    if (!manual) return "model cancelled";
    providerName = providerChoice;
    modelId = manual;
  } else {
    const entry = entries.find((item) => item.value === picked);
    if (!entry) return "model cancelled";
    providerName = entry.provider;
    modelId = entry.model;
  }

  const provider = connected.find((item) => item.name === providerName);
  if (!provider) throw new Error(`provider not connected: ${providerName}`);

  await persistModelDefault(options, providerName, modelId, provider.kind, provider.baseUrl, provider.apiKeyEnv);
  await options.setModel({
    provider: providerName,
    id: modelId,
    name: modelId,
    api: providerApi(provider.kind),
  });
  options.sink.setStatus?.("model", `${providerName}/${modelId}`);
  return `model ${providerName}/${modelId}`;
}

async function resolvePresetForConnect(
  preset: ProviderPreset,
  interactive: InteractiveIO,
): Promise<ProviderPreset | undefined> {
  if (!preset.custom) return preset;
  const idRaw = await interactive.prompt("Provider id (e.g. my-llm)");
  if (!idRaw) return undefined;
  const id = normalizeProviderId(idRaw);
  if (!id) {
    throw new Error("invalid provider id");
  }
  const baseUrl = await interactive.prompt("Base URL (OpenAI-compatible, e.g. https://api.example.com/v1)");
  if (!baseUrl) return undefined;
  const apiKeyEnv = `${id.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_API_KEY`;
  const defaultModel = (await interactive.prompt("Default model id")) ?? "default";
  return {
    id,
    label: id,
    kind: "openai",
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKeyEnv,
    defaultModel,
    sampleModels: [defaultModel],
    custom: true,
  };
}

async function persistConnect(input: Readonly<{
  options: ConnectCommandOptions;
  providerName: string;
  kind: string;
  baseUrl?: string;
  apiKeyEnv: string;
  apiKey: string;
  modelId: string;
  models: readonly string[];
}>): Promise<void> {
  const { options } = input;
  options.env[input.apiKeyEnv] = input.apiKey;
  await saveProviderCredential(input.providerName, {
    apiKey: input.apiKey,
    models: input.models,
    baseUrl: input.baseUrl,
  }, options.env);

  const configPath = await resolveConfigPath(options.env);
  const content = await readFile(configPath, "utf8");
  const next = mutateConnectConfig(content, {
    name: input.providerName,
    kind: input.kind,
    baseUrl: input.baseUrl,
    model: input.modelId,
    apiKeyEnv: input.apiKeyEnv,
  });
  await writeFile(configPath, next, "utf8");

  const providerConfig: XioProviderConfig = {
    name: input.providerName,
    kind: input.kind,
    baseUrl: input.baseUrl,
    model: input.modelId,
    apiKeyEnv: input.apiKeyEnv,
  };
  options.host.registerProvider(input.providerName, toRegistration(providerConfig, input.models));
  await applyCredentialsToEnv(options.env, {
    ...options.runtimeConfig.providers,
    [input.providerName]: providerConfig,
  });
}

async function persistModelDefault(
  options: ConnectCommandOptions,
  providerName: string,
  modelId: string,
  kind: string,
  baseUrl: string | undefined,
  apiKeyEnv: string | undefined,
): Promise<void> {
  const configPath = await resolveConfigPath(options.env);
  const content = await readFile(configPath, "utf8");
  const envName = apiKeyEnv ?? targetApiKeyEnv({
    name: providerName,
    kind,
    apiKeyEnv,
  });
  const next = mutateConnectConfig(content, {
    name: providerName,
    kind,
    baseUrl,
    model: modelId,
    apiKeyEnv: envName,
  });
  await writeFile(configPath, next, "utf8");

  const existing = options.host.getProvider(providerName);
  if (existing) {
    const models = uniqueModels([modelId, ...existing.models.map((model) => model.id)]);
    const template = existing.models[0];
    options.host.registerProvider(providerName, {
      ...existing,
      models: models.map((id) => {
        const prev = existing.models.find((model) => model.id === id);
        return {
          id,
          name: id,
          reasoning: prev?.reasoning ?? template?.reasoning ?? true,
          thinkingLevelMap: prev?.thinkingLevelMap ?? template?.thinkingLevelMap,
          input: prev?.input ?? template?.input ?? (["text"] as ("text" | "image")[]),
          contextWindow: prev?.contextWindow ?? template?.contextWindow ?? 128_000,
          maxTokens: prev?.maxTokens ?? template?.maxTokens ?? 8192,
          headers: prev?.headers ?? template?.headers,
          compat: prev?.compat ?? template?.compat,
          cost: prev?.cost ?? template?.cost,
        };
      }),
    });
  }
}

async function listConnectedProviders(options: ConnectCommandOptions): Promise<readonly XioProviderConfig[]> {
  const credentials = await loadCredentials(options.env);
  const names = new Set<string>([
    ...Object.keys(credentials.providers),
    ...options.host.listProviders().map((provider) => provider.name).filter((name) => {
      const registration = options.host.getProvider(name);
      if (!registration?.apiKey?.startsWith("$")) return false;
      const value = options.env[registration.apiKey.slice(1)];
      return typeof value === "string" && value.length > 0;
    }),
    ...Object.keys(options.runtimeConfig.providers).filter((name) => {
      const provider = options.runtimeConfig.providers[name];
      if (!provider?.apiKeyEnv) return false;
      const value = options.env[provider.apiKeyEnv];
      return typeof value === "string" && value.length > 0;
    }),
  ]);
  const result: XioProviderConfig[] = [];
  for (const name of names) {
    const configured = options.runtimeConfig.providers[name];
    const registration = options.host.getProvider(name);
    const cred = credentials.providers[name];
    const preset = findProviderPreset(name);
    const apiKeyEnv = configured?.apiKeyEnv
      ?? (registration?.apiKey?.startsWith("$") ? registration.apiKey.slice(1) : undefined)
      ?? preset?.apiKeyEnv;
    result.push({
      name,
      kind: configured?.kind ?? preset?.kind ?? kindFromApi(registration?.api),
      baseUrl: configured?.baseUrl ?? cred?.baseUrl ?? registration?.baseUrl ?? preset?.baseUrl,
      model: configured?.model ?? registration?.models[0]?.id ?? preset?.defaultModel,
      apiKeyEnv,
    });
  }
  return result;
}

async function collectModelsForProvider(
  provider: XioProviderConfig,
  options: ConnectCommandOptions,
): Promise<readonly string[]> {
  const credentials = await loadCredentials(options.env);
  const cached = credentials.providers[provider.name]?.models ?? [];
  const preset = findProviderPreset(provider.name);
  const registered = options.host.getProvider(provider.name)?.models.map((model) => model.id) ?? [];
  const envName = provider.apiKeyEnv ?? preset?.apiKeyEnv;
  const apiKey = envName ? options.env[envName] : undefined;
  const catalog = uniqueModels([
    ...(provider.model ? [provider.model] : []),
    ...cached,
    ...registered,
    ...(preset?.sampleModels ?? []),
  ]);
  if (apiKey) {
    const discovered = await discoverModels({
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      apiKey,
      catalogModels: catalog,
      fetchImpl: options.fetchImpl,
    });
    if (discovered.models.length > 0) return discovered.models;
  }
  return catalog;
}

function toRegistration(provider: XioProviderConfig, models: readonly string[]): ProviderRegistration {
  const modelIds = uniqueModels([...(provider.model ? [provider.model] : []), ...models]);
  return {
    name: provider.name,
    api: providerApi(provider.kind),
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKeyEnv ? `$${provider.apiKeyEnv}` : undefined,
    authHeader: true,
    thinkingDisplay: provider.thinkingDisplay,
    toolChoice: provider.toolChoice,
    toolChoiceScope: provider.toolChoiceScope,
    models: modelIds.map((id) => ({
      id,
      name: id,
      reasoning: provider.reasoning ?? true,
      thinkingLevelMap: provider.thinkingLevelMap,
      input: ["text"] as ("text" | "image")[],
      contextWindow: provider.contextWindow ?? 128_000,
      maxTokens: provider.maxTokens ?? 8192,
      headers: provider.headers,
      compat: provider.compat,
    })),
  };
}

function uniqueModels(models: readonly string[]): string[] {
  return [...new Set(models.filter((id) => id.length > 0))];
}

function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function kindFromApi(api: string | undefined): string {
  if (api === "anthropic-messages") return "anthropic";
  if (api === "google-generative-ai") return "google";
  if (api === "google-vertex") return "google-vertex";
  if (api === "mistral-conversations") return "mistral";
  if (api === "bedrock-converse-stream") return "bedrock";
  return "openai";
}
