import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
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
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

/** Fill missing provider API key env vars from credentials.json (env wins). */
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
