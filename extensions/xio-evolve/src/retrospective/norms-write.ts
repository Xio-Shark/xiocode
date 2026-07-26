import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Paths allowed for norms auto-write under the workspace root. */
export const NORMS_ALLOWLIST_ROOT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export const NORMS_ALLOWLIST_SPEC_PREFIX = ".trellis/spec";

export type NormsProposedFile = Readonly<{
  /** Relative path from workspace root using `/` separators. */
  relativePath: string;
  /** Proposed full file body. */
  content: string;
  /** Short human summary for confirm UX. */
  summary?: string;
}>;

export type NormsPendingOffer = Readonly<{
  schema_version: "xio-pending-norms.v1";
  created_at: string;
  run_id: string;
  workspace_root: string;
  files: readonly NormsProposedFile[];
}>;

export type NormsWriteResult = Readonly<{
  written: readonly string[];
  backups: readonly string[];
  rejected: readonly string[];
}>;

export function defaultPendingNormsPath(): string {
  return path.join(os.homedir(), ".xiocode", "retrospective", "pending-norms.json");
}

/**
 * Resolve and validate an allowlisted relative path.
 * Returns absolute path or throws / returns error reason.
 */
export function resolveNormsAllowlistPath(
  workspaceRoot: string,
  relativePath: string,
): Readonly<{ ok: true; absolutePath: string; relativePath: string } | { ok: false; reason: string }> {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.includes("\0") || path.isAbsolute(normalized)) {
    return { ok: false, reason: `absolute or invalid path: ${relativePath}` };
  }
  if (normalized.split("/").includes("..")) {
    return { ok: false, reason: `path escape: ${relativePath}` };
  }

  const rootFile = NORMS_ALLOWLIST_ROOT_FILES.find((name) => name === normalized);
  if (rootFile) {
    const absolutePath = path.resolve(workspaceRoot, rootFile);
    if (!absolutePath.startsWith(path.resolve(workspaceRoot) + path.sep)
      && absolutePath !== path.resolve(workspaceRoot, rootFile)) {
      return { ok: false, reason: `escapes workspace: ${relativePath}` };
    }
    return { ok: true, absolutePath, relativePath: rootFile };
  }

  if (normalized === NORMS_ALLOWLIST_SPEC_PREFIX || normalized.startsWith(`${NORMS_ALLOWLIST_SPEC_PREFIX}/`)) {
    const absolutePath = path.resolve(workspaceRoot, normalized);
    const specRoot = path.resolve(workspaceRoot, NORMS_ALLOWLIST_SPEC_PREFIX);
    if (absolutePath !== specRoot && !absolutePath.startsWith(specRoot + path.sep)) {
      return { ok: false, reason: `must stay under ${NORMS_ALLOWLIST_SPEC_PREFIX}/: ${relativePath}` };
    }
    return { ok: true, absolutePath, relativePath: normalized };
  }

  return {
    ok: false,
    reason: `not in allowlist (AGENTS.md|CLAUDE.md|.trellis/spec/**): ${relativePath}`,
  };
}

export function formatNormsConfirmDetail(files: readonly NormsProposedFile[]): string {
  const lines = [
    "Proposed norms writes (all-or-nothing):",
    ...files.map((file) => {
      const summary = file.summary?.trim() || `${file.content.length} chars`;
      return `- ${file.relativePath}: ${summary}`;
    }),
    "",
    "Accept writes these paths (with .bak-<timestamp> for existing files).",
    "Reject keeps drafts only — no workspace norms changes.",
  ];
  return lines.join("\n");
}

export async function writePendingNormsOffer(
  offer: NormsPendingOffer,
  filePath: string = defaultPendingNormsPath(),
): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(offer, null, 2)}\n`, "utf8");
  return filePath;
}

export async function readPendingNormsOffer(
  filePath: string = defaultPendingNormsPath(),
): Promise<NormsPendingOffer | undefined> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as NormsPendingOffer;
    if (raw.schema_version !== "xio-pending-norms.v1" || !Array.isArray(raw.files)) {
      return undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

export async function clearPendingNormsOffer(
  filePath: string = defaultPendingNormsPath(),
): Promise<void> {
  try {
    await writeFile(filePath, "", "utf8");
    await rename(filePath, `${filePath}.cleared-${Date.now()}`);
  } catch {
    // ignore missing
  }
}

/**
 * Apply allowlisted writes. Rejects the whole batch if any path fails allowlist.
 * Does not ask — caller must have obtained strong confirmation.
 */
export async function applyNormsWrites(input: Readonly<{
  workspaceRoot: string;
  files: readonly NormsProposedFile[];
  now?: () => number;
}>): Promise<NormsWriteResult> {
  const resolved: Array<{ absolutePath: string; relativePath: string; content: string }> = [];
  const rejected: string[] = [];
  for (const file of input.files) {
    const check = resolveNormsAllowlistPath(input.workspaceRoot, file.relativePath);
    if (!check.ok) {
      rejected.push(`${file.relativePath}: ${check.reason}`);
      continue;
    }
    resolved.push({
      absolutePath: check.absolutePath,
      relativePath: check.relativePath,
      content: file.content,
    });
  }
  if (rejected.length > 0) {
    return { written: [], backups: [], rejected };
  }

  const stamp = (input.now ?? Date.now)();
  const written: string[] = [];
  const backups: string[] = [];
  for (const file of resolved) {
    await mkdir(path.dirname(file.absolutePath), { recursive: true });
    try {
      await readFile(file.absolutePath, "utf8");
      const bak = `${file.absolutePath}.bak-${stamp}`;
      await rename(file.absolutePath, bak);
      backups.push(bak);
    } catch {
      // new file
    }
    await writeFile(file.absolutePath, file.content.endsWith("\n") ? file.content : `${file.content}\n`, "utf8");
    written.push(file.relativePath);
  }
  return { written, backups, rejected: [] };
}
