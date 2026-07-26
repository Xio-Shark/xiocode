import os from "node:os";
import { readFile } from "node:fs/promises";

import { XIO_VERSION } from "./version.ts";
import { loadCredentials, resolveCredentialsPath } from "./credentials.ts";
import { resolveConfigPath } from "./ensure-config.ts";
import { parseXioConfig } from "./config-parser.ts";
import { PROVIDER_PRESETS } from "./provider-catalog.ts";
import { discoverModels } from "../runtime/providers/discover.ts";
import { providerErrorGuidance } from "../runtime/providers/error-guidance.ts";

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 6;
const CONNECT_TIMEOUT_MS = 4_000;

export type DoctorCliOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  write?: (chunk: string) => void;
  fetchImpl?: typeof fetch;
  /** Skip provider connectivity probes (no network). */
  offline?: boolean;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
}>;

type CheckStatus = "ok" | "warn" | "fail";

type CheckRow = Readonly<{
  status: CheckStatus;
  name: string;
  detail: string;
  /** Actionable next step shown under a warn/fail row. */
  fix?: string;
}>;

/**
 * `xio doctor` — one-command environment self-check. Output is designed to be
 * pasted into bug reports: no secrets, one line per check, actionable fixes.
 */
export async function runDoctorCli(options: DoctorCliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const rows: CheckRow[] = [];

  rows.push(checkNode(options.nodeVersion ?? process.versions.node));
  rows.push(checkPlatform(options.platform ?? process.platform));
  rows.push(await checkConfig(env));

  const keyed = await collectProviderKeys(env);
  rows.push(checkKeys(keyed, env));

  if (!options.offline) {
    rows.push(...await checkConnectivity(keyed, options.fetchImpl));
  }

  write(`XioCode doctor — ${XIO_VERSION} — paste this output into bug reports\n`);
  write(`OS: ${os.type()} ${os.release()} ${os.arch()}\n\n`);
  for (const row of rows) {
    write(`${symbol(row.status)} ${row.name.padEnd(10)} ${row.detail}\n`);
    if (row.fix && row.status !== "ok") {
      write(`    → ${row.fix}\n`);
    }
  }
  const problems = rows.filter((row) => row.status === "fail").length;
  const warnings = rows.filter((row) => row.status === "warn").length;
  write(`\nResult: ${problems === 0 ? "no blocking problems" : `${problems} problem(s)`}`
    + `${warnings > 0 ? `, ${warnings} warning(s)` : ""}\n`);
  return problems === 0 ? 0 : 1;
}

function checkNode(version: string): CheckRow {
  const [majorRaw, minorRaw] = version.split(".");
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const ok = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
  if (ok) {
    return { status: "ok", name: "node", detail: `v${version} (>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} required)` };
  }
  return {
    status: "fail",
    name: "node",
    detail: `v${version} is too old (>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} required)`,
    fix: "Upgrade Node: https://nodejs.org — or rerun install.sh, it prints the one-line command for your platform.",
  };
}

function checkPlatform(platform: NodeJS.Platform): CheckRow {
  if (platform === "darwin" || platform === "linux") {
    return { status: "ok", name: "platform", detail: `${platform} — supported` };
  }
  if (platform === "win32") {
    return {
      status: "warn",
      name: "platform",
      detail: "Windows — untested",
      fix: "Use WSL: https://learn.microsoft.com/windows/wsl/install",
    };
  }
  return { status: "warn", name: "platform", detail: `${platform} — untested` };
}

async function checkConfig(env: NodeJS.ProcessEnv): Promise<CheckRow> {
  const configPath = await resolveConfigPath(env);
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return {
        status: "warn",
        name: "config",
        detail: `${shortPath(configPath)} missing`,
        fix: "Run `xio init` (or just `xio` — it creates the default config on first run).",
      };
    }
    return {
      status: "fail",
      name: "config",
      detail: `${shortPath(configPath)} unreadable: ${message(error)}`,
      fix: "Fix file permissions, or delete it and run `xio init` again.",
    };
  }
  try {
    parseXioConfig(content);
    return { status: "ok", name: "config", detail: `${shortPath(configPath)} parsed OK` };
  } catch (error) {
    return {
      status: "fail",
      name: "config",
      detail: `${shortPath(configPath)} invalid: ${message(error)}`,
      fix: "Fix the TOML above, or move the file away and run `xio init` to regenerate defaults.",
    };
  }
}

type KeyedProvider = Readonly<{
  id: string;
  kind: string;
  baseUrl?: string;
  apiKey: string;
  source: string;
  sampleModels: readonly string[];
}>;

async function collectProviderKeys(env: NodeJS.ProcessEnv): Promise<readonly KeyedProvider[]> {
  let credentials: Awaited<ReturnType<typeof loadCredentials>>;
  try {
    credentials = await loadCredentials(env);
  } catch {
    credentials = { version: 1, providers: {} };
  }
  const keyed: KeyedProvider[] = [];
  for (const preset of PROVIDER_PRESETS) {
    if (preset.custom) continue;
    const fromEnv = env[preset.apiKeyEnv];
    const stored = credentials.providers[preset.id];
    const apiKey = fromEnv && fromEnv.length > 0 ? fromEnv : stored?.apiKey;
    if (!apiKey) continue;
    keyed.push({
      id: preset.id,
      kind: preset.kind,
      baseUrl: stored?.baseUrl ?? preset.baseUrl,
      apiKey,
      source: fromEnv && fromEnv.length > 0 ? `env ${preset.apiKeyEnv}` : "credentials.json",
      sampleModels: preset.sampleModels,
    });
  }
  // Custom providers stored via /connect (not in the preset catalog).
  for (const [id, entry] of Object.entries(credentials.providers)) {
    if (keyed.some((row) => row.id === id)) continue;
    if (PROVIDER_PRESETS.some((preset) => preset.id === id && !preset.custom)) continue;
    if (!entry.apiKey || !entry.baseUrl) continue;
    keyed.push({
      id,
      kind: "openai",
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      source: "credentials.json",
      sampleModels: entry.models ?? [],
    });
  }
  return keyed;
}

function checkKeys(keyed: readonly KeyedProvider[], env: NodeJS.ProcessEnv): CheckRow {
  if (keyed.length === 0) {
    return {
      status: "fail",
      name: "keys",
      detail: `no provider API key found (checked env vars and ${shortPath(resolveCredentialsPath(env))})`,
      fix: "Run `xio` and use /connect, or `export DEEPSEEK_API_KEY=sk-...` (any supported provider works).",
    };
  }
  const detail = keyed.map((row) => `${row.id} (${row.source})`).join(", ");
  return { status: "ok", name: "keys", detail };
}

async function checkConnectivity(
  keyed: readonly KeyedProvider[],
  fetchImpl?: typeof fetch,
): Promise<readonly CheckRow[]> {
  if (keyed.length === 0) {
    return [{
      status: "warn",
      name: "connect",
      detail: "skipped — no keys to probe",
      fix: "Add a key first (see the keys check above).",
    }];
  }
  const rows: CheckRow[] = [];
  for (const provider of keyed) {
    try {
      const discovered = await withTimeout(
        discoverModels({
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          catalogModels: provider.sampleModels,
          fetchImpl,
        }),
        CONNECT_TIMEOUT_MS,
        `connect(${provider.id})`,
      );
      if (discovered.error) {
        rows.push({
          status: "fail",
          name: "connect",
          detail: `${provider.id}: ${discovered.error}`,
          fix: connectivityFix(discovered.error),
        });
      } else {
        rows.push({
          status: "ok",
          name: "connect",
          detail: `${provider.id}: reachable (${discovered.models.length} models)`,
        });
      }
    } catch (error) {
      rows.push({
        status: "fail",
        name: "connect",
        detail: `${provider.id}: ${message(error)}`,
        fix: connectivityFix(message(error)),
      });
    }
  }
  return rows;
}

function connectivityFix(error: string): string {
  return providerErrorGuidance({ message: error })
    ?? "Retry `xio doctor`; if it persists, open an issue with this output attached.";
}

function symbol(status: CheckStatus): string {
  if (status === "ok") return "✅";
  if (status === "warn") return "⚠️";
  return "❌";
}

function shortPath(value: string): string {
  const home = os.homedir();
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
