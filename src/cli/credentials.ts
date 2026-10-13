import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writePrivateFileAtomic } from "../runtime/private-fs.ts";
import { expandHome } from "./config-parser.ts";
import { targetApiKeyEnv } from "./env-setup.ts";

import type { XioProviderConfig } from "./config-parser.ts";

export type CredentialProviderEntry = Readonly<{
  apiKey: string;
  updatedAt: string;
  models?: readonly string[];
  baseUrl?: string;
}>;

export type CredentialsFile = Readonly<{
  version: 1;
  providers: Readonly<Record<string, CredentialProviderEntry>>;
}>;

const EMPTY: CredentialsFile = { version: 1, providers: {} };

export function resolveCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XIO_CREDENTIALS) {
    return expandHome(env.XIO_CREDENTIALS);
  }
  const home = expandHome(env.XIO_HOME ?? path.join(os.homedir(), ".xiocode"));
  return path.join(home, "credentials.json");
}

export async function loadCredentials(env: NodeJS.ProcessEnv = process.env): Promise<CredentialsFile> {
  const filePath = resolveCredentialsPath(env);
  try {
    const raw = await readFile(filePath, "utf8");
    return normalizeCredentials(JSON.parse(raw));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return EMPTY;
    throw error;
  }
}

export async function saveProviderCredential(
  name: string,
  entry: Readonly<{ apiKey: string; models?: readonly string[]; baseUrl?: string }>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const filePath = resolveCredentialsPath(env);
  const current = await loadCredentials(env);
  const next: CredentialsFile = {
    version: 1,
    providers: {
      ...current.providers,
      [name]: {
        apiKey: entry.apiKey,
        updatedAt: new Date().toISOString(),
        ...(entry.models && entry.models.length > 0 ? { models: [...entry.models] } : {}),
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      },
    },
  };
  await writePrivateFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return filePath;
}

export type CredentialMigration = Readonly<{ from: string; to: string }>;

const sameBaseUrl = (a: string | undefined, b: string | undefined): boolean =>
  Boolean(a && b && a.replace(/\/+$/, "") === b.replace(/\/+$/, ""));

/**
 * Keys are looked up by provider name, so a key saved under a name no provider
 * uses (an older `/connect` with a hand-typed id, e.g. `opencodego`, while the
 * config calls the provider `opencode`) is invisible. Such an entry is renamed to
 * the one configured provider without a key of its own that has the same base
 * URL. A key saved for another configured provider is never moved: two providers
 * on one gateway can hold different accounts. Returns what moved, to report.
 */
export async function migrateCredentialNames(
  providers: Readonly<Record<string, XioProviderConfig>>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly CredentialMigration[]> {
  const current = await loadCredentials(env);
  const next: Record<string, CredentialProviderEntry> = { ...current.providers };
  const migrations: CredentialMigration[] = [];
  for (const [from, entry] of Object.entries(current.providers)) {
    if (providers[from]) continue;
    const targets = Object.values(providers).filter((provider) =>
      !next[provider.name] && sameBaseUrl(entry.baseUrl, provider.baseUrl));
    if (targets.length !== 1) continue;
    const to = targets[0]!.name;
    next[to] = entry;
    delete next[from];
    migrations.push({ from, to });
  }
  if (migrations.length > 0) {
    await writePrivateFileAtomic(
      resolveCredentialsPath(env),
      `${JSON.stringify({ version: 1, providers: next } satisfies CredentialsFile, null, 2)}\n`,
    );
  }
  return migrations;
}

export function formatCredentialMigration(migration: CredentialMigration): string {
  return `credentials: the key saved as "${migration.from}" now belongs to provider "${migration.to}" `
    + `(no provider is named "${migration.from}"; same base_url)`;
}

/** Fill missing provider API key env vars from credentials.json (env wins).
 * @deprecated Prefer SecretEnvironment.create — production paths must not mutate shared process.env.
 */
export async function applyCredentialsToEnv(
  env: NodeJS.ProcessEnv,
  providers: Readonly<Record<string, XioProviderConfig>>,
): Promise<void> {
  const credentials = await loadCredentials(env);
  for (const [name, entry] of Object.entries(credentials.providers)) {
    if (!entry.apiKey) continue;
    const provider = providers[name] ?? {
      name,
      kind: "openai" as const,
      apiKeyEnv: undefined,
    };
    const envName = provider.apiKeyEnv ?? targetApiKeyEnv(provider);
    if (!env[envName] || env[envName]!.length === 0) {
      env[envName] = entry.apiKey;
    }
  }
}

function normalizeCredentials(value: unknown): CredentialsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY;
  const record = value as Record<string, unknown>;
  const providersRaw = record.providers;
  if (!providersRaw || typeof providersRaw !== "object" || Array.isArray(providersRaw)) {
    return EMPTY;
  }
  const providers: Record<string, CredentialProviderEntry> = {};
  for (const [name, entry] of Object.entries(providersRaw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.apiKey !== "string" || row.apiKey.length === 0) continue;
    const models = Array.isArray(row.models)
      ? row.models.filter((item): item is string => typeof item === "string" && item.length > 0)
      : undefined;
    providers[name] = {
      apiKey: row.apiKey,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date(0).toISOString(),
      ...(models && models.length > 0 ? { models } : {}),
      ...(typeof row.baseUrl === "string" && row.baseUrl.length > 0 ? { baseUrl: row.baseUrl } : {}),
    };
  }
  return { version: 1, providers };
}
