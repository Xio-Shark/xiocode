/**
 * Project trust gate: decide whether a workspace may load project-local
 * hooks/skills/extensions and use write/exec tools at full capability.
 *
 * Persistence: ~/.xiocode/trust.json (normalized absolute paths).
 * Config: [trust] mode = ask | trust | off
 *
 * Trust is never granted via shared Git common-dir / linked-worktree
 * inheritance. Optional head/tree identity binds persisted grants when Git
 * is available. Product-created worktrees may use an in-memory session grant.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { writePrivateFileAtomic } from "./private-fs.ts";

/** Config / CLI policy — how to treat unknown directories. */
export type TrustMode = "ask" | "trust" | "off";

/**
 * Runtime decision for the current cwd.
 * - trusted: full project resources + normal permission gate
 * - session_only: same as trusted for this process; not persisted
 * - untrusted: skip project resources; restrict write/exec/MCP
 */
export type TrustDecision = "trusted" | "session_only" | "untrusted";

/** Optional content/revision binding for a persisted trust grant. */
export type ProjectTrustIdentity = Readonly<{
  headCommit: string;
  headTree: string;
}>;

/**
 * In-memory grant issued by a validated XioCode worktree launch.
 * Never persisted; never deserialized from disk/env as authority.
 */
export type ProjectTrustSessionGrant = Readonly<{
  issuer: "xio-worktree-launch";
  canonicalRoot: string;
  mainRoot: string;
  sessionId: string;
  repoId: string;
  headCommit: string;
  baselineTree: string;
}>;

export type TrustStoreEntry = Readonly<{
  level: "trusted" | "denied";
  /** When set, this entry also covers descendants of the path. */
  coverChildren?: boolean;
  /** When set on trusted entries, must exact-match current HEAD identity. */
  identity?: ProjectTrustIdentity;
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

export type WorktreeLink = Readonly<{
  /** Working directory of the main repository that owns the shared .git. */
  mainPath: string;
  /** Top-level directory of the linked worktree containing cwd. */
  worktreeRoot: string;
}>;

/**
 * Detect whether cwd lives inside a linked git worktree.
 * Diagnostics / identity discovery only — never used to grant trust.
 */
export function resolveLinkedWorktree(cwd: string): WorktreeLink | undefined {
  const result = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "--git-dir", "--git-common-dir", "--show-toplevel"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  const [gitDirRaw, commonDirRaw, toplevelRaw] = result.stdout
    .split("\n")
    .map((line) => line.trim());
  if (!gitDirRaw || !commonDirRaw || !toplevelRaw) return undefined;
  const gitDir = normalizeTrustPath(path.resolve(cwd, gitDirRaw));
  const commonDir = normalizeTrustPath(path.resolve(cwd, commonDirRaw));
  // Same git dir → main repository (or plain repo, or submodule).
  if (gitDir === commonDir) return undefined;
  // A bare main repo has no working directory that could hold a trust grant.
  if (path.basename(commonDir) !== ".git") return undefined;
  return {
    mainPath: path.dirname(commonDir),
    worktreeRoot: normalizeTrustPath(path.resolve(cwd, toplevelRaw)),
  };
}

/** Resolve HEAD^{commit} and HEAD^{tree} when cwd is inside a git worktree. */
export function resolveGitTrustIdentity(cwd: string): ProjectTrustIdentity | undefined {
  const result = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "HEAD^{commit}", "HEAD^{tree}"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  const [headCommit, headTree] = result.stdout.split("\n").map((line) => line.trim());
  if (!headCommit || !headTree) return undefined;
  return { headCommit, headTree };
}

/**
 * Capture the visible tree (tracked + untracked, no ignored) at HEAD.
 * Used to validate product worktree session grants.
 */
export function captureVisibleTreeSync(cwd: string, baseRef: string): string | undefined {
  const tempDir = spawnSync("mktemp", ["-d", "-t", "xio-trust-tree-XXXXXX"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (tempDir.status !== 0 || typeof tempDir.stdout !== "string") return undefined;
  const indexDir = tempDir.stdout.trim();
  const indexFile = path.join(indexDir, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    const readTree = spawnSync("git", ["-C", cwd, "read-tree", baseRef], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (readTree.status !== 0) return undefined;
    const add = spawnSync("git", ["-C", cwd, "add", "-A", "--", "."], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (add.status !== 0) return undefined;
    const writeTree = spawnSync("git", ["-C", cwd, "write-tree"], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (writeTree.status !== 0 || typeof writeTree.stdout !== "string") return undefined;
    const tree = writeTree.stdout.trim();
    return tree.length > 0 ? tree : undefined;
  } finally {
    spawnSync("rm", ["-rf", indexDir], { stdio: "ignore" });
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
 * Build a session grant from a validated WorktreeSession-shaped object.
 * Caller must have already created/attached the worktree via WorktreeSandbox.
 */
export function sessionGrantFromWorktree(session: Readonly<{
  mainRoot: string;
  worktreePath: string;
  sessionId: string;
  repoId: string;
  baseRef: string;
  baselineTree: string;
}>): ProjectTrustSessionGrant {
  return {
    issuer: "xio-worktree-launch",
    canonicalRoot: normalizeTrustPath(session.worktreePath),
    mainRoot: normalizeTrustPath(session.mainRoot),
    sessionId: session.sessionId,
    repoId: session.repoId,
    headCommit: session.baseRef,
    baselineTree: session.baselineTree,
  };
}

/**
 * Validate an in-memory product worktree session grant against the live cwd.
 * Returns true only when issuer/path/headCommit/visible-tree all still match.
 */
export function validateSessionGrant(
  cwd: string,
  grant: ProjectTrustSessionGrant,
): boolean {
  if (grant.issuer !== "xio-worktree-launch") return false;
  const normalized = normalizeTrustPath(cwd);
  if (normalized !== normalizeTrustPath(grant.canonicalRoot)) return false;
  const identity = resolveGitTrustIdentity(cwd);
  if (!identity) return false;
  if (identity.headCommit !== grant.headCommit) return false;
  const visible = captureVisibleTreeSync(cwd, grant.headCommit);
  if (!visible || visible !== grant.baselineTree) return false;
  return true;
}

/**
 * Sync lookup against an in-memory store (no I/O).
 * mode=off|trust → trusted without consulting entries.
 * mode=ask → trusted/denied from store; unknown → untrusted.
 *
 * Linked-worktree / common-dir inheritance is intentionally absent.
 * A structured sessionGrant yields session_only only after live path/head/tree
 * validation; never overrides an exact denied store entry.
 */
export function decideTrust(input: Readonly<{
  cwd: string;
  mode: TrustMode;
  store?: TrustStoreFile;
  /**
   * In-memory product worktree session grant (not persisted).
   * Must pass validateSessionGrant against cwd or it is ignored.
   */
  sessionGrant?: ProjectTrustSessionGrant;
  /** @deprecated Use sessionGrant. Bare boolean is rejected as insufficient. */
  sessionGranted?: boolean;
  /**
   * @deprecated Linked-worktree info is ignored for authorization.
   * Kept so callers do not break; never grants trust.
   */
  worktree?: WorktreeLink;
  /** Current git identity for matching identity-bound store entries. */
  currentIdentity?: ProjectTrustIdentity;
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

  const match = lookupTrustEntry(input.store, normalizedPath);
  if (match?.level === "denied") {
    return {
      cwd: input.cwd,
      normalizedPath,
      mode: input.mode,
      decision: "untrusted",
      persisted: true,
    };
  }

  // Bare boolean sessionGranted is intentionally insufficient (S-05).
  if (input.sessionGranted === true && !input.sessionGrant) {
    return {
      cwd: input.cwd,
      normalizedPath,
      mode: input.mode,
      decision: "untrusted",
      persisted: false,
    };
  }

  if (input.sessionGrant && validateSessionGrant(input.cwd, input.sessionGrant)) {
    return {
      cwd: input.cwd,
      normalizedPath,
      mode: input.mode,
      decision: "session_only",
      persisted: false,
    };
  }

  if (match?.level === "trusted") {
    if (match.identity) {
      const current = input.currentIdentity ?? resolveGitTrustIdentity(input.cwd);
      if (
        !current
        || current.headCommit !== match.identity.headCommit
        || current.headTree !== match.identity.headTree
      ) {
        return {
          cwd: input.cwd,
          normalizedPath,
          mode: input.mode,
          decision: "untrusted",
          persisted: false,
        };
      }
    }
    return {
      cwd: input.cwd,
      normalizedPath,
      mode: input.mode,
      decision: "trusted",
      persisted: true,
    };
  }

  // input.worktree is ignored — common-dir must never grant trust.
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
  // Longest covering parent wins. coverChildren must not cross worktrees;
  // callers bind keys to canonical roots, so path-prefix coverage stays
  // within one workspace tree.
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
    const identity = parseIdentity(entry.identity);
    entries[key] = {
      level,
      coverChildren: entry.coverChildren === true ? true : undefined,
      ...(identity ? { identity } : {}),
      updatedAt,
    };
  }
  return { version: TRUST_FILE_VERSION, entries };
}

export async function saveTrustStore(filePath: string, store: TrustStoreFile): Promise<void> {
  const payload: TrustStoreFile = {
    version: TRUST_FILE_VERSION,
    entries: store.entries,
  };
  await writePrivateFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

export async function grantTrust(input: Readonly<{
  cwd: string;
  storePath?: string;
  home?: string;
  coverChildren?: boolean;
  /** When omitted, capture current Git HEAD identity if available. */
  identity?: ProjectTrustIdentity;
}>): Promise<ProjectTrustState> {
  const storePath = input.storePath ?? defaultTrustStorePath(input.home);
  const store = await loadTrustStore(storePath);
  const normalizedPath = normalizeTrustPath(input.cwd);
  const identity = input.identity ?? resolveGitTrustIdentity(input.cwd);
  const next: TrustStoreFile = {
    version: TRUST_FILE_VERSION,
    entries: {
      ...store.entries,
      [normalizedPath]: {
        level: "trusted",
        coverChildren: input.coverChildren === true ? true : undefined,
        ...(identity ? { identity } : {}),
        updatedAt: new Date().toISOString(),
      },
    },
  };
  await saveTrustStore(storePath, next);
  return decideTrust({
    cwd: input.cwd,
    mode: "ask",
    store: next,
    currentIdentity: identity,
  });
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
 * - mode ask + store hit with matching identity → use store
 * - mode ask + validated sessionGrant → session_only (not persisted)
 * - mode ask + unknown + interactive → ask once (y = persist trust, n = untrusted)
 * - mode ask + unknown + non-interactive → untrusted (degraded; still launches)
 *
 * Linked worktrees never inherit trust from the main repository path.
 */
export async function ensureProjectTrust(input: Readonly<{
  cwd: string;
  mode: TrustMode;
  home?: string;
  storePath?: string;
  interactiveSession?: boolean;
  ask?: (question: string, detail?: string) => Promise<boolean>;
  notify?: (message: string) => void;
  /** Validated product worktree session grant (in-memory only). */
  sessionGrant?: ProjectTrustSessionGrant;
}>): Promise<ProjectTrustState> {
  const home = input.home ?? os.homedir();
  const storePath = input.storePath ?? defaultTrustStorePath(home);
  const store = await loadTrustStore(storePath);
  const currentIdentity = resolveGitTrustIdentity(input.cwd);

  // Exact denial always wins over session grant.
  const denied = lookupTrustEntry(store, normalizeTrustPath(input.cwd));
  if (denied?.level === "denied" && input.mode === "ask") {
    const state = decideTrust({ cwd: input.cwd, mode: input.mode, store, currentIdentity });
    input.notify?.(
      `Project trust: untrusted (${state.normalizedPath}). Persisted denial; project resources skipped.`,
    );
    return state;
  }

  if (input.sessionGrant && validateSessionGrant(input.cwd, input.sessionGrant)) {
    const state = decideTrust({
      cwd: input.cwd,
      mode: input.mode,
      store,
      sessionGrant: input.sessionGrant,
      currentIdentity,
    });
    if (state.decision === "session_only") {
      input.notify?.(
        `Project trust: session grant for ${state.normalizedPath} (product worktree; not persisted).`,
      );
      return state;
    }
  }

  const initial = decideTrust({
    cwd: input.cwd,
    mode: input.mode,
    store,
    currentIdentity,
  });

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

  const identityDetail = currentIdentity
    ? `\nhead: ${currentIdentity.headCommit.slice(0, 12)}\ntree: ${currentIdentity.headTree.slice(0, 12)}`
    : "";
  const ok = await input.ask(
    `Trust this project directory for hooks/skills/extensions and write/exec tools? [y/N] `,
    `cwd: ${initial.normalizedPath}${identityDetail}\npersist: ~/.xiocode/trust.json\nuntrusted: skip project hooks/skills/MCP; restrict write/exec`,
  );
  if (!ok) {
    input.notify?.(
      `Project trust: declined (${initial.normalizedPath}). Running with degraded capabilities.`,
    );
    return initial;
  }

  const granted = await grantTrust({
    cwd: input.cwd,
    storePath,
    home,
    identity: currentIdentity,
  });
  input.notify?.(`Project trust: granted for ${granted.normalizedPath}`);
  return granted;
}

function parseIdentity(value: unknown): ProjectTrustIdentity | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const headCommit = typeof record.headCommit === "string" ? record.headCommit : undefined;
  const headTree = typeof record.headTree === "string" ? record.headTree : undefined;
  if (!headCommit || !headTree) return undefined;
  return { headCommit, headTree };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
