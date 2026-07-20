/**
 * Project trust gate: decide whether a workspace may load project-local
 * hooks/skills/extensions and use write/exec tools at full capability.
 *
 * Persistence: ~/.xiocode/trust.json (normalized absolute paths).
 * Config: [trust] mode = ask | trust | off
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Config / CLI policy — how to treat unknown directories. */
export type TrustMode = "ask" | "trust" | "off";

/**
 * Runtime decision for the current cwd.
 * - trusted: full project resources + normal permission gate
 * - session_only: same as trusted for this process; not persisted
 * - untrusted: skip project resources; restrict write/exec/MCP
 */
export type TrustDecision = "trusted" | "session_only" | "untrusted";

export type TrustStoreEntry = Readonly<{
  level: "trusted" | "denied";
  /** When set, this entry also covers descendants of the path. */
  coverChildren?: boolean;
  updatedAt: string;
}>;

export type TrustStoreFile = Readonly<{
  version: 1;
  entries: Readonly<Record<string, TrustStoreEntry>>;
}>;

export type ProjectTrustState = Readonly<{
  cwd: string;
  normalizedPath: string;
  mode: TrustMode;
  decision: TrustDecision;
  /** True when decision came from a persisted store entry (or parent cover). */
  persisted: boolean;
}>;

const TRUST_FILE_VERSION = 1 as const;

export function defaultTrustStorePath(home = os.homedir()): string {
  return path.join(home, ".xiocode", "trust.json");
}

/** Normalize cwd for stable trust keys (realpath when possible). */
export function normalizeTrustPath(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function parseTrustMode(raw: unknown): TrustMode | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "ask" || value === "trust" || value === "off") return value;
  return undefined;
}

export function allowsProjectResources(decision: TrustDecision): boolean {
  return decision === "trusted" || decision === "session_only";
}

/**
 * Sync lookup against an in-memory store (no I/O).
 * mode=off|trust → trusted without consulting entries.
 * mode=ask → trusted/denied from store; unknown → untrusted.
 */
export function decideTrust(input: Readonly<{
  cwd: string;
  mode: TrustMode;
  store?: TrustStoreFile;
  /** In-memory session grant (not persisted). */
  sessionGranted?: boolean;
}>): ProjectTrustState {
  const normalizedPath = normalizeTrustPath(input.cwd);
  if (input.mode === "off" || input.mode === "trust") {
    return {
      cwd: input.cwd,
      normalizedPath,
      mode: input.mode,
      decision: "trusted",
      persisted: false,
    };
  }
  if (input.sessionGranted) {
    return {
      cwd: input.cwd,
      normalizedPath,
      mode: input.mode,
      decision: "session_only",
      persisted: false,
    };
  }
  const match = lookupTrustEntry(input.store, normalizedPath);
  if (match?.level === "trusted") {
    return {
      cwd: input.cwd,
      normalizedPath,
      mode: input.mode,
      decision: "trusted",
      persisted: true,
    };
  }
  if (match?.level === "denied") {
    return {
      cwd: input.cwd,
      normalizedPath,
      mode: input.mode,
      decision: "untrusted",
      persisted: true,
    };
  }
  return {
    cwd: input.cwd,
    normalizedPath,
    mode: input.mode,
    decision: "untrusted",
    persisted: false,
  };
}

export function lookupTrustEntry(
  store: TrustStoreFile | undefined,
  normalizedPath: string,
): TrustStoreEntry | undefined {
  if (!store) return undefined;
  const exact = store.entries[normalizedPath];
  if (exact) return exact;
  // Longest covering parent wins.
  let best: { path: string; entry: TrustStoreEntry } | undefined;
  for (const [entryPath, entry] of Object.entries(store.entries)) {
    if (!entry.coverChildren) continue;
    if (normalizedPath === entryPath || normalizedPath.startsWith(`${entryPath}${path.sep}`)) {
      if (!best || entryPath.length > best.path.length) {
        best = { path: entryPath, entry };
      }
    }
  }
  return best?.entry;
}

export async function loadTrustStore(filePath: string): Promise<TrustStoreFile> {
  try {
    const raw = await readFile(filePath, "utf8");
    return parseTrustStore(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isNotFound(error)) {
      return emptyTrustStore();
    }
    throw error;
  }
}

export function emptyTrustStore(): TrustStoreFile {
  return { version: TRUST_FILE_VERSION, entries: {} };
}

export function parseTrustStore(data: unknown): TrustStoreFile {
  const root = asRecord(data);
  if (!root) return emptyTrustStore();
  const version = root.version;
  if (version !== undefined && version !== 1) {
    // Forward-compatible: ignore unknown versions as empty (do not clobber).
    return emptyTrustStore();
  }
  const entriesTable = asRecord(root.entries) ?? {};
  const entries: Record<string, TrustStoreEntry> = {};
  for (const [key, value] of Object.entries(entriesTable)) {
    const entry = asRecord(value);
    if (!entry) continue;
    const level = entry.level === "denied" ? "denied" : entry.level === "trusted" ? "trusted" : undefined;
    if (!level) continue;
    const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString();
    entries[key] = {
      level,
      coverChildren: entry.coverChildren === true ? true : undefined,
      updatedAt,
    };
  }
  return { version: TRUST_FILE_VERSION, entries };
}

export async function saveTrustStore(filePath: string, store: TrustStoreFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload: TrustStoreFile = {
    version: TRUST_FILE_VERSION,
    entries: store.entries,
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function grantTrust(input: Readonly<{
  cwd: string;
  storePath?: string;
  home?: string;
  coverChildren?: boolean;
}>): Promise<ProjectTrustState> {
  const storePath = input.storePath ?? defaultTrustStorePath(input.home);
  const store = await loadTrustStore(storePath);
  const normalizedPath = normalizeTrustPath(input.cwd);
  const next: TrustStoreFile = {
    version: TRUST_FILE_VERSION,
    entries: {
      ...store.entries,
      [normalizedPath]: {
        level: "trusted",
        coverChildren: input.coverChildren === true ? true : undefined,
        updatedAt: new Date().toISOString(),
      },
    },
  };
  await saveTrustStore(storePath, next);
  return decideTrust({ cwd: input.cwd, mode: "ask", store: next });
}

export async function revokeTrust(input: Readonly<{
  cwd: string;
  storePath?: string;
  home?: string;
}>): Promise<void> {
  const storePath = input.storePath ?? defaultTrustStorePath(input.home);
  const store = await loadTrustStore(storePath);
  const normalizedPath = normalizeTrustPath(input.cwd);
  if (!(normalizedPath in store.entries)) return;
  const entries = { ...store.entries };
  delete entries[normalizedPath];
  await saveTrustStore(storePath, { version: TRUST_FILE_VERSION, entries });
}

/**
 * Resolve trust for session bootstrap.
 * - mode off/trust → trusted (no prompt)
 * - mode ask + store hit → use store
 * - mode ask + unknown + interactive → ask once (y = persist trust, n = untrusted)
 * - mode ask + unknown + non-interactive → untrusted (degraded; still launches)
 */
export async function ensureProjectTrust(input: Readonly<{
  cwd: string;
  mode: TrustMode;
  home?: string;
  storePath?: string;
  interactiveSession?: boolean;
  ask?: (question: string, detail?: string) => Promise<boolean>;
  notify?: (message: string) => void;
}>): Promise<ProjectTrustState> {
  const home = input.home ?? os.homedir();
  const storePath = input.storePath ?? defaultTrustStorePath(home);
  const store = await loadTrustStore(storePath);
  const initial = decideTrust({ cwd: input.cwd, mode: input.mode, store });
  if (input.mode !== "ask" || initial.persisted || initial.decision === "trusted") {
    if (initial.decision === "untrusted" && input.mode === "ask") {
      input.notify?.(
        `Project trust: untrusted (${initial.normalizedPath}). Project hooks/skills/MCP skipped; write/exec restricted.`,
      );
    }
    return initial;
  }

  const interactive = input.interactiveSession !== false;
  if (!interactive || !input.ask) {
    input.notify?.(
      `Project trust: untrusted (${initial.normalizedPath}). Non-interactive session — project resources skipped.`,
    );
    return initial;
  }

  const ok = await input.ask(
    `Trust this project directory for hooks/skills/extensions and write/exec tools? [y/N] `,
    `cwd: ${initial.normalizedPath}\npersist: ~/.xiocode/trust.json\nuntrusted: skip project hooks/skills/MCP; restrict write/exec`,
  );
  if (!ok) {
    input.notify?.(
      `Project trust: declined (${initial.normalizedPath}). Running with degraded capabilities.`,
    );
    return initial;
  }

  const granted = await grantTrust({ cwd: input.cwd, storePath, home });
  input.notify?.(`Project trust: granted for ${granted.normalizedPath}`);
  return granted;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
