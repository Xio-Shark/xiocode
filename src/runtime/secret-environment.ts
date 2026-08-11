/**
 * Session-scoped secret store + child-env builder + value redaction.
 * Never mutates the parent process.env used for spawning children.
 */

import { loadCredentials, type CredentialsFile } from "../cli/credentials.ts";
import { targetApiKeyEnv } from "../cli/env-setup.ts";
import { withProviderGuidance } from "./providers/error-guidance.ts";

import type { XioProviderConfig } from "../cli/config-parser.ts";
import type { ProviderRegistration } from "./types.ts";

const MIN_EXACT_REDACT_LEN = 8;
const REDACT_PLACEHOLDER = "[redacted]";

/** Executable / home / temp — always inherited when present on parent. */
const BASE_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  // Locale / time
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_COLLATE",
  "TZ",
  // Terminal
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  // Windows
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "WINDIR",
  "USERNAME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROCESSOR_ARCHITECTURE",
] as const;

/** TLS CA paths for network-capable children (real eval / provider). */
export const NETWORK_TLS_ENV_NAMES = [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
] as const;

const SENSITIVE_NAME = /(?:^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)(_|$)/i;
const WHOLE_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const LITERAL_DOLLAR = /^\$\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const PARTIAL_REF = /\$\{/;

export type BuildChildEnvOptions = Readonly<{
  /** Extra parent env names to inherit (non-secret only). */
  extraNames?: readonly string[];
  /** Exact key/value overrides written after allowlist copy. */
  overrides?: Readonly<Record<string, string>>;
  /** When true (default), drop any value that matches a known secret. */
  rejectKnownSecrets?: boolean;
  /** Include TLS CA path variables from parent. */
  includeNetworkTls?: boolean;
  /** Known secret values (from SecretEnvironment or ad-hoc). */
  knownSecretValues?: ReadonlySet<string> | readonly string[];
  /** Provider / sensitive env names that must never pass via extraNames. */
  blockedNames?: ReadonlySet<string> | readonly string[];
}>;

export type SecretEnvironmentCreateOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  providers?: Readonly<Record<string, XioProviderConfig>>;
  credentials?: CredentialsFile;
}>;

export class SecretEnvironment {
  readonly #secrets = new Map<string, string>();
  readonly #knownValues = new Set<string>();
  readonly #parentEnv: NodeJS.ProcessEnv;
  #disposed = false;

  private constructor(parentEnv: NodeJS.ProcessEnv) {
    this.#parentEnv = parentEnv;
  }

  static async create(options: SecretEnvironmentCreateOptions = {}): Promise<SecretEnvironment> {
    const env = options.env ?? process.env;
    const store = new SecretEnvironment(env);
    const providers = options.providers ?? {};
    const credentials = options.credentials ?? await loadCredentials(env);

    // Configured providers first (env wins over credentials).
    for (const provider of Object.values(providers)) {
      const envName = provider.apiKeyEnv ?? targetApiKeyEnv(provider);
      const fromEnv = nonEmpty(env[envName]);
      const fromCred = credentials.providers[provider.name]?.apiKey;
      const value = fromEnv ?? (fromCred && fromCred.length > 0 ? fromCred : undefined);
      if (value) {
        store.setSecret(envName, value);
        const canonical = targetApiKeyEnv(provider);
        if (canonical !== envName) {
          store.setSecret(canonical, value);
        }
      }
    }

    // Credentials for providers not listed in config.
    for (const [name, entry] of Object.entries(credentials.providers)) {
      if (!entry.apiKey) continue;
      if (providers[name]) continue;
      const envName = targetApiKeyEnv({ name, kind: "openai", apiKeyEnv: undefined });
      if (!store.#secrets.has(envName)) {
        const fromEnv = nonEmpty(env[envName]);
        store.setSecret(envName, fromEnv ?? entry.apiKey);
      }
    }

    // Bootstrap sensitive-named env values for redaction (do not expose via get unless set).
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string" || value.length === 0) continue;
      if (isSensitiveEnvName(key)) {
        store.registerKnownValue(value);
      }
    }

    return store;
  }

  /** Opaque JSON — never serialize secrets. */
  toJSON(): string {
    return "[SecretEnvironment]";
  }

  has(name: string): boolean {
    this.assertOpen();
    return this.#secrets.has(name);
  }

  /** Resolve a provider registration `$ENV` or literal key. */
  resolveProvider(registration: ProviderRegistration): string {
    this.assertOpen();
    const raw = registration.apiKey ?? "";
    if (raw.startsWith("$")) {
      const envName = raw.slice(1);
      const value = this.#secrets.get(envName);
      if (!value) {
        const nearMiss = [...this.#secrets.keys()].find(
          (name) => name !== envName && name.toUpperCase() === envName.toUpperCase(),
        );
        const detail = nearMiss
          ? ` — store has ${nearMiss}, which differs only by case`
          : "";
        throw new Error(withProviderGuidance(`missing API key env: ${envName}${detail}`));
      }
      return value;
    }
    if (raw.length > 0) {
      this.registerKnownValue(raw);
      return raw;
    }
    throw new Error(withProviderGuidance(`provider ${registration.name} has no apiKey configured`));
  }

  /** Whether a `$ENV` registration can be resolved (status probe; no throw). */
  canResolveProvider(registration: ProviderRegistration): boolean {
    this.assertOpen();
    const raw = registration.apiKey ?? "";
    if (raw.startsWith("$")) {
      return this.#secrets.has(raw.slice(1));
    }
    return raw.length > 0;
  }

  /**
   * `/connect` success: update live session store (does not write process.env).
   */
  setProvider(envName: string, value: string): void {
    this.assertOpen();
    this.setSecret(envName, value);
  }

  /**
   * Explicit child/MCP reference: secret map first, then bootstrap parent env.
   * Empty / missing → undefined (caller fail-closed).
   */
  resolveExplicitReference(name: string): string | undefined {
    this.assertOpen();
    const fromStore = this.#secrets.get(name);
    if (fromStore !== undefined && fromStore.length > 0) return fromStore;
    return nonEmpty(this.#parentEnv[name]);
  }

  registerKnownValue(value: string): void {
    this.assertOpen();
    if (value.length >= MIN_EXACT_REDACT_LEN) {
      this.#knownValues.add(value);
    }
  }

  knownSecretValues(): ReadonlySet<string> {
    this.assertOpen();
    return this.#knownValues;
  }

  providerEnvNames(): ReadonlySet<string> {
    this.assertOpen();
    return new Set(this.#secrets.keys());
  }

  /** Immutable projection for UI / events / trajectory / hooks. */
  redactProjection<T>(value: T): T {
    this.assertOpen();
    return redactWithKnownValues(value, this.#knownValues) as T;
  }

  buildChildEnv(
    parent: NodeJS.ProcessEnv = this.#parentEnv,
    options: BuildChildEnvOptions = {},
  ): NodeJS.ProcessEnv {
    this.assertOpen();
    return buildChildEnv(parent, {
      ...options,
      knownSecretValues: options.knownSecretValues ?? this.#knownValues,
      blockedNames: options.blockedNames ?? this.providerEnvNames(),
    });
  }

  dispose(): void {
    this.#secrets.clear();
    this.#knownValues.clear();
    this.#disposed = true;
  }

  private setSecret(name: string, value: string): void {
    this.#secrets.set(name, value);
    this.registerKnownValue(value);
  }

  private assertOpen(): void {
    if (this.#disposed) {
      throw new Error("SecretEnvironment disposed");
    }
  }
}

/**
 * Pure child-env builder. Copies only allowlisted names from parent.
 * Never inherits full process.env.
 */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  options: BuildChildEnvOptions = {},
): NodeJS.ProcessEnv {
  const rejectKnown = options.rejectKnownSecrets !== false;
  const known = toValueSet(options.knownSecretValues);
  const blocked = toNameSet(options.blockedNames);
  const child: NodeJS.ProcessEnv = {};

  const copyName = (name: string): void => {
    if (blocked.has(name) || isSensitiveEnvName(name)) return;
    const value = parent[name];
    if (typeof value !== "string") return;
    if (rejectKnown && known.has(value)) return;
    // Case-insensitive PATH dedupe on Windows-ish parents.
    const existingKey = Object.keys(child).find((k) => k.toUpperCase() === name.toUpperCase());
    if (existingKey) {
      child[existingKey] = value;
      return;
    }
    child[name] = value;
  };

  for (const name of BASE_ENV_NAMES) {
    copyName(name);
  }
  if (options.includeNetworkTls) {
    for (const name of NETWORK_TLS_ENV_NAMES) {
      copyName(name);
    }
  }
  for (const name of options.extraNames ?? []) {
    copyName(name);
  }
  if (options.overrides) {
    for (const [key, value] of Object.entries(options.overrides)) {
      child[key] = value;
    }
  }
  return child;
}

export function isSensitiveEnvName(name: string): boolean {
  if (SENSITIVE_NAME.test(name)) return true;
  const upper = name.toUpperCase();
  if (upper.startsWith("AWS_") || upper.startsWith("GOOGLE_") || upper === "KUBECONFIG") {
    return true;
  }
  if (upper === "SSH_AUTH_SOCK" || upper === "GIT_ASKPASS") return true;
  if (upper === "NODE_OPTIONS" || upper === "NODE_PATH") return true;
  if (upper === "HTTP_PROXY" || upper === "HTTPS_PROXY" || upper === "ALL_PROXY") return true;
  if (upper.startsWith("NPM_") || upper.startsWith("NPM_CONFIG")) return true;
  return false;
}

/**
 * Resolve MCP `spec.env` entries.
 * - whole-string `${NAME}` → resolve via resolver
 * - `$${NAME}` → literal `${NAME}`
 * - other strings with `${` → fail closed
 * - plain literals passed through
 * Never copies parent process.env.
 */
export function resolveMcpEnvEntries(
  declared: Readonly<Record<string, string>> | undefined,
  resolve: (name: string) => string | undefined,
  options: Readonly<{
    onResolvedSecret?: (name: string, value: string) => void;
  }> = {},
): Record<string, string> | undefined {
  if (!declared) return undefined;
  const out: Record<string, string> = {};
  for (const [dest, raw] of Object.entries(declared)) {
    const literalEscaped = LITERAL_DOLLAR.exec(raw);
    if (literalEscaped) {
      out[dest] = `\${${literalEscaped[1]}}`;
      continue;
    }
    const whole = WHOLE_REF.exec(raw);
    if (whole) {
      const source = whole[1]!;
      const value = resolve(source);
      if (value === undefined || value.length === 0) {
        throw new Error(`MCP env reference unresolved: ${dest} → \${${source}}`);
      }
      out[dest] = value;
      if (isSensitiveEnvName(dest) || isSensitiveEnvName(source)) {
        options.onResolvedSecret?.(dest, value);
      }
      continue;
    }
    if (PARTIAL_REF.test(raw)) {
      throw new Error(
        `MCP env ${dest}: only whole-string \${NAME} references are supported (got partial interpolation)`,
      );
    }
    out[dest] = raw;
    if (isSensitiveEnvName(dest) && raw.length >= MIN_EXACT_REDACT_LEN) {
      options.onResolvedSecret?.(dest, raw);
    }
  }
  return out;
}

/** Exact known-value redaction + sensitive key names. Immutable projection. */
export function redactWithKnownValues(
  value: unknown,
  knownValues: ReadonlySet<string> | readonly string[],
  depth = 0,
): unknown {
  const known = [...toValueSet(knownValues)].sort((a, b) => b.length - a.length);
  return redactValue(value, known, depth);
}

const SECRET_KEY =
  /^(?:api[_-]?key|authorization|password|secret|token|access_token|refresh_token|cookie|credential)s?$/i;
const MAX_STRING = 8_000;
const MAX_DEPTH = 6;

function redactValue(value: unknown, known: readonly string[], depth: number): unknown {
  if (depth > MAX_DEPTH) return "[max-depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    let text = value;
    for (const secret of known) {
      if (secret.length >= MIN_EXACT_REDACT_LEN && text.includes(secret)) {
        text = text.split(secret).join(REDACT_PLACEHOLDER);
      }
    }
    return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…[truncated]` : text;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, known, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) {
        out[key] = REDACT_PLACEHOLDER;
        continue;
      }
      out[key] = redactValue(child, known, depth + 1);
    }
    return out;
  }
  return String(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function toValueSet(values: ReadonlySet<string> | readonly string[] | undefined): Set<string> {
  if (!values) return new Set();
  return values instanceof Set ? new Set(values) : new Set(values);
}

function toNameSet(names: ReadonlySet<string> | Iterable<string> | undefined): Set<string> {
  if (!names) return new Set();
  return names instanceof Set ? new Set(names) : new Set(names);
}
