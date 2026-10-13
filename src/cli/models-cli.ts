import { formatCredentialMigration, loadCredentials, migrateCredentialNames, saveProviderCredential } from "./credentials.ts";
import { PROVIDER_PRESETS } from "./provider-catalog.ts";
import { ensureConfigFile } from "./ensure-config.ts";
import { parseXioConfig, type XioProviderConfig } from "./config-parser.ts";
import { discoverModels } from "../runtime/providers/discover.ts";
import { resolveModelApi, wireApiEndpoint } from "../runtime/providers/wire-api.ts";
import { providerApi } from "../runtime/provider-registry.ts";
import { formatModelPrice, resolveModelPrice, type PricingOverrides } from "../runtime/pricing.ts";

const DISCOVER_TIMEOUT_MS = 2_500;

export type ModelsCliOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  write?: (chunk: string) => void;
  writeErr?: (chunk: string) => void;
  fetchImpl?: typeof fetch;
  /** Skip remote discovery (catalog + credentials cache only). */
  catalogOnly?: boolean;
  /** Replace each saved model list with the one the provider reports now. */
  refresh?: boolean;
}>;

type ProviderSource = {
  name: string;
  kind: string;
  baseUrl?: string;
  apiKey?: string;
  modelApis?: XioProviderConfig["modelApis"];
  /** Preset samples and the configured model. */
  catalog: Set<string>;
  /** Saved in credentials.json by /connect (the list --refresh replaces). */
  saved?: readonly string[];
  /** What the provider's /models returned, when it answered. */
  live?: ReadonlySet<string>;
  error?: string;
};

/**
 * List known models with unit pricing, the endpoint each is called on, default
 * indicator, credential status, and `[offline]` for models the provider no longer
 * lists. Does not start a worktree session.
 */
export async function runModelsCli(options: ModelsCliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const writeErr = options.writeErr ?? ((chunk: string) => process.stderr.write(chunk));
  if (options.refresh && options.catalogOnly) {
    writeErr("xio models: --refresh cannot be combined with --catalog-only.\n");
    return 1;
  }

  let defaultProvider = "deepseek";
  let defaultModel = "deepseek-chat";
  let pricingOverrides: PricingOverrides = {};
  let configured: Readonly<Record<string, XioProviderConfig>> = {};
  try {
    const ensured = await ensureConfigFile(env);
    const parsed = parseXioConfig(ensured.content);
    defaultProvider = parsed.xio.general.defaultProvider ?? "deepseek";
    defaultModel = parsed.xio.general.defaultModel ?? "deepseek-chat";
    pricingOverrides = parsed.runtimeConfig.pricing ?? {};
    configured = parsed.xio.providers;
  } catch (error) {
    // The listing still works without config, but the defaults shown are then the built-in ones.
    writeErr(`xio models: could not read config.toml (${error instanceof Error ? error.message : String(error)}); `
      + "default provider, model and pricing overrides below are the built-in ones.\n");
  }

  for (const migration of await migrateCredentialNames(configured, env)) {
    writeErr(`${formatCredentialMigration(migration)}\n`);
  }
  const sources = collectSources(configured, await loadCredentials(env), env);

  if (!options.catalogOnly) {
    await Promise.all([...sources.values()].map((source) => discoverLive(source, options, writeErr)));
  }
  if (options.refresh) {
    await refreshSaved(sources, env, writeErr);
  }

  const rows: Array<{ id: string; price: string; endpoint: string; tags: string }> = [];
  for (const source of [...sources.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const registration = { name: source.name, api: providerApi(source.kind), baseUrl: source.baseUrl, modelApis: source.modelApis, models: [] };
    const models = new Set([...source.catalog, ...(source.saved ?? []), ...(source.live ?? [])]);
    for (const model of [...models].sort((a, b) => a.localeCompare(b))) {
      const tags: string[] = [];
      if (source.name === defaultProvider && model === defaultModel) tags.push("(default)");
      if (source.apiKey) tags.push("[configured]");
      if (source.live && !source.live.has(model)) tags.push("[offline]");
      rows.push({
        id: `${source.name}/${model}`,
        price: formatModelPrice(resolveModelPrice(model, { provider: source.name, overrides: pricingOverrides })),
        endpoint: wireApiEndpoint(resolveModelApi(registration, model)),
        tags: tags.join(" "),
      });
    }
  }

  const idWidth = Math.max(28, ...rows.map((row) => row.id.length)) + 2;
  const priceWidth = Math.max(16, ...rows.map((row) => row.price.length)) + 2;
  const endpointWidth = Math.max(...rows.map((row) => row.endpoint.length), 0) + 2;
  for (const row of rows) {
    write(`${row.id.padEnd(idWidth)}${row.price.padEnd(priceWidth)}${row.endpoint.padEnd(endpointWidth)}${row.tags}`.trimEnd() + "\n");
  }
  return options.refresh && [...sources.values()].some((source) => source.error) ? 1 : 0;
}

function collectSources(
  configured: Readonly<Record<string, XioProviderConfig>>,
  credentials: Awaited<ReturnType<typeof loadCredentials>>,
  env: NodeJS.ProcessEnv,
): Map<string, ProviderSource> {
  const sources = new Map<string, ProviderSource>();
  const source = (name: string, kind: string): ProviderSource => {
    const existing = sources.get(name);
    if (existing) return existing;
    const created: ProviderSource = { name, kind, catalog: new Set() };
    sources.set(name, created);
    return created;
  };
  for (const preset of PROVIDER_PRESETS) {
    if (preset.custom) continue;
    const entry = source(preset.id, preset.kind);
    entry.baseUrl = preset.baseUrl;
    entry.apiKey = env[preset.apiKeyEnv] || undefined;
    for (const model of [preset.defaultModel, ...preset.sampleModels]) entry.catalog.add(model);
  }
  for (const provider of Object.values(configured)) {
    const entry = source(provider.name, provider.kind);
    entry.kind = provider.kind;
    entry.baseUrl = provider.baseUrl ?? entry.baseUrl;
    entry.modelApis = provider.modelApis;
    if (provider.apiKeyEnv && env[provider.apiKeyEnv]) entry.apiKey = env[provider.apiKeyEnv];
    if (provider.model) entry.catalog.add(provider.model);
  }
  for (const [name, saved] of Object.entries(credentials.providers)) {
    const entry = source(name, "openai");
    entry.baseUrl = entry.baseUrl ?? saved.baseUrl;
    entry.apiKey = entry.apiKey ?? saved.apiKey;
    entry.saved = saved.models ?? [];
  }
  return sources;
}

async function discoverLive(
  source: ProviderSource,
  options: ModelsCliOptions,
  writeErr: (chunk: string) => void,
): Promise<void> {
  if (!source.apiKey) return;
  const discovered = await discoverModels({ kind: source.kind, baseUrl: source.baseUrl,
    apiKey: source.apiKey, fetchImpl: options.fetchImpl, timeoutMs: DISCOVER_TIMEOUT_MS });
  source.error = discovered.error;
  if (discovered.error) writeErr(`warning: ${source.name}: ${discovered.error}\n`);
  if (discovered.source === "api") source.live = new Set(discovered.models);
}

async function refreshSaved(
  sources: ReadonlyMap<string, ProviderSource>,
  env: NodeJS.ProcessEnv,
  writeErr: (chunk: string) => void,
): Promise<void> {
  const credentials = await loadCredentials(env);
  for (const source of sources.values()) {
    const saved = credentials.providers[source.name];
    if (!saved || !source.live) continue;
    const live = [...source.live].sort((a, b) => a.localeCompare(b));
    const dropped = (saved.models ?? []).filter((model) => !source.live!.has(model));
    const added = live.filter((model) => !(saved.models ?? []).includes(model));
    if (dropped.length === 0 && added.length === 0) continue;
    await saveProviderCredential(source.name, { apiKey: saved.apiKey, models: live, baseUrl: saved.baseUrl }, env);
    source.saved = live;
    writeErr(`${source.name}: saved model list refreshed (${live.length} models`
      + `${dropped.length > 0 ? `; removed ${dropped.join(", ")}` : ""}`
      + `${added.length > 0 ? `; added ${added.join(", ")}` : ""}).\n`);
  }
}
