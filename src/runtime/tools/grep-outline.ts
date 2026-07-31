import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Structure-aware grep helpers (jcode-style lightweight outline + adaptive truncation).
 *
 * These are **heuristics, not a full AST / tree-sitter parse**: symbol lines are matched
 * by declaration-shaped regexes per language, with a generic fallback. The goal is a cheap,
 * dependency-free hint so the model does not have to re-`read` a whole file after a grep hit.
 *
 * Adaptive truncation: `GrepSeenState` remembers which files already had their outline
 * emitted this session, so repeat hits on the same file drop the outline (a one-line note
 * is kept) instead of re-spending context on the same structure.
 */

const DEFAULT_MAX_OUTLINE_FILES = 8;
const DEFAULT_MAX_SYMBOLS_PER_FILE = 12;

/** Session-scoped memory of files whose outline was already shown (keyed by grep relpath). */
export class GrepSeenState {
  readonly #files = new Set<string>();

  /** @returns true when the outline for this path was already emitted this session. */
  seen(relPath: string): boolean {
    return this.#files.has(relPath);
  }

  mark(relPath: string): void {
    this.#files.add(relPath);
  }

  clear(): void {
    this.#files.clear();
  }

  get size(): number {
    return this.#files.size;
  }
}

type OutlineRule = Readonly<{ exts: readonly string[]; patterns: readonly RegExp[] }>;

const OUTLINE_RULES: readonly OutlineRule[] = [
  {
    exts: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    patterns: [
      /^\s*(?:export\s+)?(?:export\s+default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+[A-Za-z_$][\w$]*/,
      /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    ],
  },
  { exts: [".py"], patterns: [/^\s*(?:async\s+)?(?:def|class)\s+[A-Za-z_]\w*/] },
  {
    exts: [".rs"],
    patterns: [/^\s*(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod)\s+/],
  },
  {
    exts: [".go"],
    patterns: [/^\s*func\s+/, /^\s*type\s+[A-Za-z_]\w*\s+(?:struct|interface)\b/],
  },
];

const GENERIC_PATTERN =
  /^\s*(?:export\s+|public\s+|private\s+|protected\s+)?(?:function|class|def|fn|func|type|interface|struct|trait|impl|enum|module|namespace)\b/;

function outlinePatternsFor(relPath: string): readonly RegExp[] {
  const ext = path.extname(relPath).toLowerCase();
  const rule = OUTLINE_RULES.find((candidate) => candidate.exts.includes(ext));
  return rule ? rule.patterns : [GENERIC_PATTERN];
}

export type OutlineSymbol = Readonly<{ line: number; text: string }>;

/**
 * Extract declaration-shaped symbol lines from file content (heuristic).
 * @param maxSymbols cap on returned symbols (older matches kept, overflow reported by caller).
 */
export function extractOutline(
  relPath: string,
  content: string,
  maxSymbols = DEFAULT_MAX_SYMBOLS_PER_FILE,
): OutlineSymbol[] {
  const patterns = outlinePatternsFor(relPath);
  const symbols: OutlineSymbol[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    if (patterns.some((pattern) => pattern.test(raw))) {
      symbols.push({ line: i + 1, text: raw.trim().slice(0, 120) });
      if (symbols.length >= maxSymbols) break;
    }
  }
  return symbols;
}

/** Parse grep hit lines (`relpath:lineno:content`) into an ordered, de-duplicated relpath list. */
export function hitFilesFromGrep(matchText: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of matchText.split("\n")) {
    const match = /^(.*?):(\d+):/.exec(line);
    if (!match) continue;
    const relPath = match[1]!;
    if (relPath.length === 0 || seen.has(relPath)) continue;
    seen.add(relPath);
    files.push(relPath);
  }
  return files;
}

export type AnnotateOptions = Readonly<{
  cwd: string;
  seen: GrepSeenState;
  maxFiles?: number;
  maxSymbolsPerFile?: number;
}>;

/**
 * Append a lightweight structure outline to grep match output.
 *
 * - New file this session → full outline block (heuristic symbols).
 * - Repeat file this session → single "outline omitted (already shown)" note (adaptive truncation).
 *
 * File read failures are skipped silently (the raw hit line still carries the match); this is a
 * best-effort hint, never a source of truth, so it must not turn a successful grep into an error.
 */
export async function annotateGrepOutput(matchText: string, options: AnnotateOptions): Promise<string> {
  const trimmed = matchText.trim();
  if (trimmed.length === 0 || trimmed === "no matches" || trimmed === "no files") {
    return matchText;
  }
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_OUTLINE_FILES;
  const maxSymbols = options.maxSymbolsPerFile ?? DEFAULT_MAX_SYMBOLS_PER_FILE;
  const files = hitFilesFromGrep(matchText).slice(0, maxFiles);
  if (files.length === 0) {
    return matchText;
  }

  const blocks: string[] = [];
  for (const relPath of files) {
    if (options.seen.seen(relPath)) {
      blocks.push(`outline ${relPath}: omitted (already shown this session)`);
      continue;
    }
    let content: string;
    try {
      content = await readFile(path.resolve(options.cwd, relPath), "utf8");
    } catch {
      continue;
    }
    options.seen.mark(relPath);
    const symbols = extractOutline(relPath, content, maxSymbols);
    if (symbols.length === 0) {
      blocks.push(`outline ${relPath}: no top-level symbols detected (heuristic)`);
      continue;
    }
    const rendered = symbols.map((symbol) => `  L${symbol.line} ${symbol.text}`);
    const header = `outline ${relPath} (heuristic, not full AST):`;
    blocks.push([header, ...rendered].join("\n"));
  }

  if (blocks.length === 0) {
    return matchText;
  }
  return `${matchText}\n\n--- structure ---\n${blocks.join("\n")}`;
}
