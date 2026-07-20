import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

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

  const roots = allowedRoots(cwd, home, options.includeProject !== false);
  const candidates = listCandidates(cwd, home, config.readClaudeDirs, options.includeProject !== false);

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
      roots,
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

function allowedRoots(cwd: string, home: string, includeProject: boolean): readonly string[] {
  const roots = [path.resolve(home, ".claude")];
  if (includeProject) {
    roots.unshift(path.resolve(cwd));
  }
  return roots;
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
  roots: readonly string[];
  home: string;
  visited: Set<string>;
  warn: (message: string) => void;
}): Promise<LoadFileResult | undefined> {
  const resolved = path.resolve(options.filePath);
  if (options.visited.has(resolved)) {
    options.warn(`agents_md: cycle detected at ${resolved}; skipping`);
    return undefined;
  }
  if (!isUnderAllowedRoot(resolved, options.roots)) {
    options.warn(`agents_md: path outside allowed roots: ${resolved}; skipping`);
    return undefined;
  }

  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return undefined;
    }
    options.warn(`agents_md: failed to read ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  options.visited.add(resolved);
  const hash = shortHash(raw);
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  const childSources: SpecSource[] = [];
  let used = 0;
  let truncated = false;

  const header = `### [agents_md] ${resolved} · sha256:${hash}`;
  const headerBlock = `${header}\n`;
  if (headerBlock.length > options.remaining) {
    truncated = true;
    const slice = headerBlock.slice(0, options.remaining);
    return {
      text: `${slice}\n\n…[truncated]`,
      bytes: options.remaining,
      sources: [{ path: resolved, hash, truncated: true, bytes: options.remaining }],
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
      const importPath = resolveImportPath(resolved, importTarget, options.home);
      const childBudget = options.remaining - used;
      const child = await loadFileWithImports({
        filePath: importPath,
        depth: options.depth + 1,
        maxDepth: options.maxDepth,
        remaining: childBudget,
        roots: options.roots,
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
      options.warn(`agents_md: max_import_depth=${options.maxDepth} at ${resolved}; leaving @${importMatch[1]} unexpanded`);
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
    sources: [{ path: resolved, hash, truncated, bytes: Math.min(used, options.remaining) }, ...childSources],
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

function isUnderAllowedRoot(filePath: string, roots: readonly string[]): boolean {
  const resolved = path.resolve(filePath);
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function shortHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

export function formatAgentsMdAddendum(bundle: SpecBundle): string {
  return bundle.text;
}
