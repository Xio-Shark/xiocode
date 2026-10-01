import { loadCredentials } from "./credentials.ts";
import { PROVIDER_PRESETS } from "./provider-catalog.ts";
import { discoverModels } from "../runtime/providers/discover.ts";

const DISCOVER_TIMEOUT_MS = 2_500;

export type ModelsCliOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  write?: (chunk: string) => void;
  writeErr?: (chunk: string) => void;
  fetchImpl?: typeof fetch;
  /** Skip remote discovery (catalog + credentials cache only). */
  catalogOnly?: boolean;
}>;

import { ensureConfigFile } from "./ensure-config.ts";
import { parseXioConfig } from "./config-parser.ts";
import { formatModelPrice, resolveModelPrice, type PricingOverrides } from "../runtime/pricing.ts";

/**
 * List known models with unit pricing, default indicator, and credential status.
 * Does not start a worktree session.
 */
export async function runModelsCli(options: ModelsCliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const writeErr = options.writeErr ?? ((chunk: string) => process.stderr.write(chunk));

  let defaultProvider = "deepseek";
  let defaultModel = "deepseek-chat";
  let pricingOverrides: PricingOverrides = {};
  try {
    const ensured = await ensureConfigFile(env);
    const parsed = parseXioConfig(ensured.content);
    defaultProvider = parsed.xio.general.defaultProvider ?? "deepseek";
    defaultModel = parsed.xio.general.defaultModel ?? "deepseek-chat";
    pricingOverrides = parsed.runtimeConfig.pricing ?? {};
  } catch (error) {
    // The listing still works without config, but the defaults shown are then the built-in ones.
    writeErr(`xio models: could not read config.toml (${error instanceof Error ? error.message : String(error)}); `
      + "default provider, model and pricing overrides below are the built-in ones.\n");
  }

  const lines = new Set<string>();
  for (const preset of PROVIDER_PRESETS) {
    if (preset.custom) continue;
    for (const model of [preset.defaultModel, ...preset.sampleModels]) {
      if (model) lines.add(`${preset.id}/${model}`);
    }
  }

  const credentials = await loadCredentials(env);
  for (const [provider, entry] of Object.entries(credentials.providers)) {
    for (const model of entry.models ?? []) {
      if (model) lines.add(`${provider}/${model}`);
    }
  }

  const configuredProviders = new Set<string>();
  for (const preset of PROVIDER_PRESETS) {
    if (preset.custom) continue;
    const apiKey = env[preset.apiKeyEnv] ?? credentials.providers[preset.id]?.apiKey;
    if (apiKey) configuredProviders.add(preset.id);
  }
  for (const [provider, entry] of Object.entries(credentials.providers)) {
    if (entry.apiKey) configuredProviders.add(provider);
  }

  if (!options.catalogOnly) {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.custom) continue;
      const apiKey = env[preset.apiKeyEnv] ?? credentials.providers[preset.id]?.apiKey;
      if (!apiKey) continue;
      const baseUrl = credentials.providers[preset.id]?.baseUrl ?? preset.baseUrl;
      try {
        const discovered = await withTimeout(
          discoverModels({
            kind: preset.kind,
            baseUrl,
            apiKey,
            catalogModels: preset.sampleModels,
            fetchImpl: options.fetchImpl,
          }),
          DISCOVER_TIMEOUT_MS,
          `discover(${preset.id})`,
        );
        if (discovered.error) {
          writeErr(`warning: ${preset.id}: ${discovered.error}\n`);
        }
        for (const model of discovered.models) {
          lines.add(`${preset.id}/${model}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeErr(`warning: ${preset.id}: ${message}\n`);
      }
    }
  }

  const sorted = [...lines].sort((a, b) => a.localeCompare(b));
  const rows: Array<{
    id: string;
    price: string;
    isDefault: boolean;
    isConfigured: boolean;
  }> = [];

  for (const line of sorted) {
    const slashIdx = line.indexOf("/");
    const provider = slashIdx !== -1 ? line.slice(0, slashIdx) : "";
    const model = slashIdx !== -1 ? line.slice(slashIdx + 1) : line;
    const price = resolveModelPrice(model, { provider, overrides: pricingOverrides });
    const isDefault = provider === defaultProvider && model === defaultModel;
    const isConfigured = configuredProviders.has(provider);
    rows.push({
      id: line,
      price: formatModelPrice(price),
      isDefault,
      isConfigured,
    });
  }

  const maxIdLen = Math.max(28, ...rows.map((r) => r.id.length));
  const maxPriceLen = Math.max(16, ...rows.map((r) => r.price.length));

  for (const row of rows) {
    const idCol = row.id.padEnd(maxIdLen + 2);
    const priceCol = row.price.padEnd(maxPriceLen + 2);
    const tags: string[] = [];
    if (row.isDefault) tags.push("(default)");
    if (row.isConfigured) tags.push("[configured]");
    const tagCol = tags.length > 0 ? tags.join(" ") : "";
    write(`${idCol}${priceCol}${tagCol}`.trimEnd() + "\n");
  }
  return 0;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timeout after ${timeoutMs}ms: ${label}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
