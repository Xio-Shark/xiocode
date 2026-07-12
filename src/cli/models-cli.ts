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

/**
 * List known models as `provider/model` lines. Does not start a worktree session.
 */
export async function runModelsCli(options: ModelsCliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const writeErr = options.writeErr ?? ((chunk: string) => process.stderr.write(chunk));

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
  for (const line of sorted) {
    write(`${line}\n`);
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
