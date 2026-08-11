import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import {
  WorkspacePathError,
  WorkspacePathPolicy,
} from "../../../src/runtime/workspace-path-policy.ts";

export type AgentsMdConfig = Readonly<{
  enabled: boolean;
  readClaudeDirs: boolean;
  maxBytes: number;
  maxImportDepth: number;
}>;

export type SpecSource = Readonly<{
  path: string;
  hash: string;
  truncated: boolean;
  bytes: number;
}>;

export type SpecBundle = Readonly<{
  text: string;
  sources: readonly SpecSource[];
  warnings: readonly string[];
}>;

export type LoadAgentsMdOptions = Readonly<{
  cwd: string;
  home?: string;
  config: AgentsMdConfig;
  /** When false, skip project CLAUDE.md/AGENTS.md (user ~/.claude still loads). */
  includeProject?: boolean;
  /** Optional warn sink (defaults to no-op). */
  warn?: (message: string) => void;
}>;

export const DEFAULT_AGENTS_MD_CONFIG: AgentsMdConfig = {
  enabled: true,
  readClaudeDirs: true,
  maxBytes: 65_536,
  maxImportDepth: 3,
};

const IMPORT_LINE = /^\s*@([^\s#]+)\s*$/;

/**
 * Load Claude Code–aligned instructions with bounded @-import expansion.
 * Merge order (Claude layout): ~/.claude/CLAUDE.md → project .claude/CLAUDE.md
 * → project CLAUDE.md → project AGENTS.md (multi-agent convention at repo root).
 * No parallel ~/.xiocode/AGENTS.md — runtime state stays under ~/.xiocode only.
 *
 * Paths use WorkspacePathPolicy: workspace + optional ~/.claude root; symlink
 * components below either root are rejected (including inside→inside links).
 */
export async function loadAgentsMd(options: LoadAgentsMdOptions): Promise<SpecBundle> {
  const config = options.config;
  if (!config.enabled) {
    return { text: "", sources: [], warnings: [] };
  }

  const home = options.home ?? homedir();
  const cwd = path.resolve(options.cwd);
  const warn = options.warn ?? (() => undefined);
  const warnings: string[] = [];
  const sources: SpecSource[] = [];
  const sections: string[] = [];
  let remaining = Math.max(0, config.maxBytes);
  const includeProject = options.includeProject !== false;

  const policy = await createAgentsPathPolicy(cwd, home, includeProject);
  if (!policy) {
    return { text: "", sources: [], warnings: [] };
  }
  const candidates = listCandidates(cwd, home, config.readClaudeDirs, includeProject);

  for (const filePath of candidates) {
    if (remaining <= 0) {
      warnings.push(`agents_md: max_bytes=${config.maxBytes} reached; skipping ${filePath}`);
      warn(warnings[warnings.length - 1]!);
      break;
    }

    const loaded = await loadFileWithImports({
      filePath,
      depth: 0,
      maxDepth: config.maxImportDepth,
      remaining,
      policy,
      home,
      visited: new Set(),
      warn: (message) => {
        warnings.push(message);
        warn(message);
      },
    });
    if (!loaded) {
      continue;
    }

    remaining -= loaded.bytes;
    sources.push(...loaded.sources);
    sections.push(loaded.text);
  }

  return {
    text: sections.filter((part) => part.length > 0).join("\n\n"),
    sources,
    warnings,
  };
}

async function createAgentsPathPolicy(
  cwd: string,
  home: string,
  includeProject: boolean,
): Promise<WorkspacePathPolicy | undefined> {
  const userClaude = path.resolve(home, ".claude");
  if (includeProject) {
    return WorkspacePathPolicy.create({
      workspaceRoot: cwd,
      cwd,
      additionalRoots: [{ id: "user-claude", path: userClaude, optional: true }],
    });
  }
  try {
    return await WorkspacePathPolicy.create({
      workspaceRoot: userClaude,
      cwd: userClaude,
    });
  } catch {
    // No ~/.claude — nothing to load when project resources are skipped.
    return undefined;
  }
}

function listCandidates(
  cwd: string,
  home: string,
  readClaudeDirs: boolean,
  includeProject: boolean,
): string[] {
  const paths: string[] = [];
  if (readClaudeDirs) {
    paths.push(path.join(home, ".claude", "CLAUDE.md"));
    if (includeProject) {
      paths.push(path.join(cwd, ".claude", "CLAUDE.md"));
    }
  }
  if (includeProject) {
    paths.push(path.join(cwd, "CLAUDE.md"));
    paths.push(path.join(cwd, "AGENTS.md"));
  }
  return paths;
}

type LoadFileResult = Readonly<{
  text: string;
  bytes: number;
  sources: readonly SpecSource[];
}>;

async function loadFileWithImports(options: {
  filePath: string;
  depth: number;
  maxDepth: number;
  remaining: number;
  policy: WorkspacePathPolicy;
  home: string;
  visited: Set<string>;
  warn: (message: string) => void;
}): Promise<LoadFileResult | undefined> {
  let checkedPath: string;
  let raw: string;
  try {
    const checked = await options.policy.resolve("project-resource", options.filePath);
    if (options.visited.has(checked.canonicalPath)) {
      options.warn(`agents_md: cycle detected at ${checked.canonicalPath}; skipping`);
      return undefined;
    }
    options.visited.add(checked.canonicalPath);
    checkedPath = checked.canonicalPath;
    raw = (await options.policy.readProjectResource(options.filePath)).toString("utf8");
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      if (error.code === "NOT_FOUND") {
        return undefined;
      }
      options.warn(`agents_md: ${error.code} for ${options.filePath}; skipping`);
      return undefined;
    }
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return undefined;
    }
    options.warn(
      `agents_md: failed to read ${options.filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }

  const hash = shortHash(raw);
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  const childSources: SpecSource[] = [];
  let used = 0;
  let truncated = false;

  const header = `### [agents_md] ${checkedPath} · sha256:${hash}`;
  const headerBlock = `${header}\n`;
  if (headerBlock.length > options.remaining) {
    truncated = true;
    const slice = headerBlock.slice(0, options.remaining);
    return {
      text: `${slice}\n\n…[truncated]`,
      bytes: options.remaining,
      sources: [{ path: checkedPath, hash, truncated: true, bytes: options.remaining }],
    };
  }
  out.push(header);
  used += headerBlock.length;

  for (const line of lines) {
    if (used >= options.remaining) {
      truncated = true;
      break;
    }

    const importMatch = IMPORT_LINE.exec(line);
    if (importMatch && options.depth < options.maxDepth) {
      const importTarget = importMatch[1];
      if (!importTarget) {
        continue;
      }
      const importPath = resolveImportPath(checkedPath, importTarget, options.home);
      const childBudget = options.remaining - used;
      const child = await loadFileWithImports({
        filePath: importPath,
        depth: options.depth + 1,
        maxDepth: options.maxDepth,
        remaining: childBudget,
        policy: options.policy,
        home: options.home,
        visited: options.visited,
        warn: options.warn,
      });
      if (!child) {
        continue;
      }
      out.push(child.text);
      used += child.bytes;
      childSources.push(...child.sources);
      continue;
    }

    if (importMatch && options.depth >= options.maxDepth) {
      options.warn(
        `agents_md: max_import_depth=${options.maxDepth} at ${checkedPath}; leaving @${importMatch[1]} unexpanded`,
      );
    }

    const next = `${line}\n`;
    if (used + next.length > options.remaining) {
      const room = options.remaining - used;
      if (room > 0) {
        out.push(next.slice(0, room));
        used += room;
      }
      truncated = true;
      break;
    }
    out.push(line);
    used += next.length;
  }

  if (truncated) {
    out.push("");
    out.push("…[truncated]");
  }

  const text = out.join("\n");
  return {
    text,
    bytes: Math.min(used, options.remaining),
    sources: [
      { path: checkedPath, hash, truncated, bytes: Math.min(used, options.remaining) },
      ...childSources,
    ],
  };
}

function resolveImportPath(fromFile: string, target: string, home: string): string {
  if (target.startsWith("~/")) {
    return path.join(home, target.slice(2));
  }
  if (target === "~") {
    return home;
  }
  if (path.isAbsolute(target)) {
    return target;
  }
  return path.resolve(path.dirname(fromFile), target);
}

function shortHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

export function formatAgentsMdAddendum(bundle: SpecBundle): string {
  return bundle.text;
}
