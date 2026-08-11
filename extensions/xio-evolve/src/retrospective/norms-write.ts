import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  WorkspacePathError,
  WorkspacePathPolicy,
  type StagedWorkspaceWrite,
} from "../../../../src/runtime/workspace-path-policy.ts";

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

export type NormsWriteStatus = "ok" | "rejected" | "rolled_back" | "rollback_failed";

export type NormsWriteResult = Readonly<{
  written: readonly string[];
  backups: readonly string[];
  rejected: readonly string[];
  status: NormsWriteStatus;
  error?: string;
}>;

export function defaultPendingNormsPath(): string {
  return path.join(os.homedir(), ".xiocode", "retrospective", "pending-norms.json");
}

/**
 * Resolve and validate an allowlisted relative path.
 * Returns absolute path or throws / returns error reason.
 * Lexical allowlist only — filesystem authorization happens in applyNormsWrites.
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
 * Apply allowlisted writes with policy-aware staging, in-process batch rollback,
 * and `.bak-<stamp>` retention on success. Rejects the whole batch if any path
 * fails allowlist or filesystem authorization. Does not ask — caller must have
 * obtained strong confirmation.
 */
export async function applyNormsWrites(input: Readonly<{
  workspaceRoot: string;
  files: readonly NormsProposedFile[];
  now?: () => number;
  /** Test/failure-injection seam for staged publish validation. */
  policyHooks?: import("../../../../src/runtime/workspace-path-policy.ts").WorkspacePathPolicyHooks;
}>): Promise<NormsWriteResult> {
  const resolved: Array<{ absolutePath: string; relativePath: string; content: string }> = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const file of input.files) {
    const check = resolveNormsAllowlistPath(input.workspaceRoot, file.relativePath);
    if (!check.ok) {
      rejected.push(`${file.relativePath}: ${check.reason}`);
      continue;
    }
    if (seen.has(check.relativePath)) {
      rejected.push(`${file.relativePath}: duplicate target in batch`);
      continue;
    }
    seen.add(check.relativePath);
    resolved.push({
      absolutePath: check.absolutePath,
      relativePath: check.relativePath,
      content: file.content.endsWith("\n") ? file.content : `${file.content}\n`,
    });
  }
  if (rejected.length > 0) {
    return { written: [], backups: [], rejected, status: "rejected" };
  }
  if (resolved.length === 0) {
    return { written: [], backups: [], rejected: [], status: "ok" };
  }

  let policy: WorkspacePathPolicy;
  try {
    policy = await WorkspacePathPolicy.create({
      workspaceRoot: input.workspaceRoot,
      cwd: input.workspaceRoot,
      hooks: input.policyHooks,
    });
  } catch (error) {
    return {
      written: [],
      backups: [],
      rejected: [`workspace: ${error instanceof Error ? error.message : String(error)}`],
      status: "rejected",
    };
  }

  const stamp = (input.now ?? Date.now)();
  const staged: Array<{
    relativePath: string;
    absolutePath: string;
    content: string;
    write: StagedWorkspaceWrite;
    prior: Buffer | undefined;
    bakPath: string;
  }> = [];

  try {
    for (const file of resolved) {
      const checked = await policy.resolve("write-file", file.relativePath);
      const prior = checked.kind === "regular-file"
        ? await policy.readFile(file.relativePath)
        : undefined;

      const bakPath = `${file.absolutePath}.bak-${stamp}`;
      if (prior) {
        const bakRelative = path.relative(policy.workspaceRoot, bakPath);
        await policy.resolve("write-file", bakRelative);
      }

      const write = await policy.stageWrite(file.relativePath, file.content);
      staged.push({
        relativePath: file.relativePath,
        absolutePath: file.absolutePath,
        content: file.content,
        write,
        prior,
        bakPath,
      });
    }
  } catch (error) {
    for (const entry of staged) {
      try {
        await entry.write.discard();
      } catch {
        // Keep original failure.
      }
    }
    return {
      written: [],
      backups: [],
      rejected: [error instanceof Error ? error.message : String(error)],
      status: "rejected",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const published: typeof staged = [];
  try {
    for (const entry of staged) {
      await entry.write.publish();
      published.push(entry);
    }
  } catch (error) {
    // Rollback must not reuse publish failure-injection hooks.
    let rollbackPolicy = policy;
    try {
      rollbackPolicy = await WorkspacePathPolicy.create({
        workspaceRoot: input.workspaceRoot,
        cwd: input.workspaceRoot,
      });
    } catch {
      // Fall back to the original policy if a fresh one cannot be created.
    }
    const rollback = await rollbackPublished(rollbackPolicy, published);
    for (const entry of staged.slice(published.length)) {
      try {
        await entry.write.discard();
      } catch {
        // Best-effort staging cleanup.
      }
    }
    return {
      written: [],
      backups: [],
      rejected: [],
      status: rollback.ok ? "rolled_back" : "rollback_failed",
      error: [
        error instanceof Error ? error.message : String(error),
        rollback.ok ? undefined : `rollback_failed: ${rollback.error}`,
      ].filter(Boolean).join("; "),
    };
  }

  const backups: string[] = [];
  for (const entry of published) {
    if (!entry.prior) continue;
    try {
      const bakRelative = path.relative(policy.workspaceRoot, entry.bakPath);
      await policy.writeFileAtomic(bakRelative, entry.prior);
      backups.push(entry.bakPath);
    } catch (error) {
      // Publish already succeeded; bak is best-effort retention of prior bytes.
      return {
        written: published.map((row) => row.relativePath),
        backups,
        rejected: [],
        status: "ok",
        error: `backup failed for ${entry.relativePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  return {
    written: published.map((row) => row.relativePath),
    backups,
    rejected: [],
    status: "ok",
  };
}

async function rollbackPublished(
  policy: WorkspacePathPolicy,
  published: readonly Readonly<{
    relativePath: string;
    prior: Buffer | undefined;
  }>[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const errors: string[] = [];
  for (const entry of [...published].reverse()) {
    try {
      if (entry.prior) {
        await policy.writeFileAtomic(entry.relativePath, entry.prior);
      } else {
        await policy.removeFile(entry.relativePath);
      }
    } catch (error) {
      errors.push(
        `${entry.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (errors.length > 0) {
    return { ok: false, error: errors.join("; ") };
  }
  return { ok: true };
}
