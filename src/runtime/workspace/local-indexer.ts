import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { isExcludedPath, sniffLanguage } from "./privacy.ts";

import type { MapEntry, OutlineSymbol } from "./types.ts";

export type LocalIndexerOptions = Readonly<{
  root: string;
  /** Max directory depth from root. Default 6. */
  maxDepth?: number;
  /** Max files to index per pass. Default 2000. */
  maxFiles?: number;
  /** Max bytes to read per file for outline. Default 64KiB. */
  maxReadBytes?: number;
}>;

export async function indexLocalTree(options: LocalIndexerOptions): Promise<readonly MapEntry[]> {
  const root = path.resolve(options.root);
  const maxDepth = options.maxDepth ?? 6;
  const maxFiles = options.maxFiles ?? 2000;
  const maxReadBytes = options.maxReadBytes ?? 64 * 1024;
  const entries: MapEntry[] = [];
  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: root, rel: "", depth: 0 },
  ];
  let files = 0;

  while (queue.length > 0 && files < maxFiles) {
    const current = queue.shift()!;
    let dirents;
    try {
      dirents = await readdir(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (files >= maxFiles) break;
      const rel = current.rel ? `${current.rel}/${dirent.name}` : dirent.name;
      if (isExcludedPath(rel)) continue;
      const abs = path.join(current.abs, dirent.name);
      if (dirent.isDirectory()) {
        entries.push({
          path: rel.replace(/\\/g, "/"),
          kind: dirent.name === "package.json" ? "package" : "dir",
          hash: `dir:${rel}`,
          updatedAt: Date.now(),
        });
        if (current.depth + 1 <= maxDepth) {
          queue.push({ abs, rel, depth: current.depth + 1 });
        }
        continue;
      }
      if (!dirent.isFile()) continue;
      files += 1;
      try {
        const info = await stat(abs);
        const language = sniffLanguage(rel);
        let outline: OutlineSymbol[] | undefined;
        let imports: string[] | undefined;
        let contentHash: string;
        if (info.size <= maxReadBytes && language) {
          const text = await readFile(abs, "utf8");
          contentHash = hashText(text);
          outline = extractOutline(text, language);
          imports = extractImports(text, language);
        } else {
          contentHash = `size:${info.size}:mtime:${Math.floor(info.mtimeMs)}`;
        }
        const kind = path.basename(rel) === "package.json" ? "package" : "file";
        entries.push({
          path: rel.replace(/\\/g, "/"),
          kind,
          language,
          hash: contentHash,
          bytes: info.size,
          outline,
          imports,
          testOwner: guessTestOwner(rel),
          rules: guessRules(rel),
          updatedAt: Date.now(),
        });
      } catch {
        // Skip unreadable files; never invent entries.
      }
    }
  }
  return entries;
}

export async function indexSingleFile(
  root: string,
  relativePath: string,
  options: Readonly<{ maxReadBytes?: number }> = {},
): Promise<MapEntry | undefined> {
  const rel = relativePath.replace(/\\/g, "/");
  if (isExcludedPath(rel)) return undefined;
  const abs = path.join(path.resolve(root), rel);
  try {
    const info = await stat(abs);
    if (!info.isFile()) {
      return {
        path: rel,
        kind: "dir",
        hash: `dir:${rel}`,
        updatedAt: Date.now(),
      };
    }
    const maxReadBytes = options.maxReadBytes ?? 64 * 1024;
    const language = sniffLanguage(rel);
    let outline: OutlineSymbol[] | undefined;
    let imports: string[] | undefined;
    let contentHash: string;
    if (info.size <= maxReadBytes) {
      const text = await readFile(abs, "utf8");
      contentHash = hashText(text);
      if (language) {
        outline = extractOutline(text, language);
        imports = extractImports(text, language);
      }
    } else {
      contentHash = `size:${info.size}:mtime:${Math.floor(info.mtimeMs)}`;
    }
    return {
      path: rel,
      kind: path.basename(rel) === "package.json" ? "package" : "file",
      language,
      hash: contentHash,
      bytes: info.size,
      outline,
      imports,
      testOwner: guessTestOwner(rel),
      rules: guessRules(rel),
      updatedAt: Date.now(),
    };
  } catch {
    return undefined;
  }
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function extractOutline(text: string, language: string): OutlineSymbol[] {
  const symbols: OutlineSymbol[] = [];
  const lines = text.split("\n");
  const patterns: Array<{ re: RegExp; kind: OutlineSymbol["kind"] }> = language === "python"
    ? [
      { re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/, kind: "function" },
      { re: /^\s*class\s+([A-Za-z_][\w]*)\s*[:\(]/, kind: "class" },
    ]
    : language === "go"
    ? [
      { re: /^func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\(/, kind: "function" },
      { re: /^type\s+([A-Za-z_][\w]*)\s+/, kind: "type" },
    ]
    : [
      { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)\s*[<(]/, kind: "function" },
      { re: /^\s*(?:export\s+)?class\s+([A-Za-z_][\w]*)\b/, kind: "class" },
      { re: /^\s*(?:export\s+)?(?:type|interface)\s+([A-Za-z_][\w]*)\b/, kind: "type" },
      { re: /^\s*(?:export\s+)?const\s+([A-Za-z_][\w]*)\s*=/, kind: "const" },
    ];
  for (let i = 0; i < lines.length && symbols.length < 40; i += 1) {
    const line = lines[i]!;
    for (const pattern of patterns) {
      const match = line.match(pattern.re);
      if (match?.[1]) {
        symbols.push({ name: match[1], kind: pattern.kind, line: i + 1 });
        break;
      }
    }
  }
  return symbols;
}

function extractImports(text: string, language: string): string[] {
  const found = new Set<string>();
  const lines = text.split("\n").slice(0, 80);
  for (const line of lines) {
    if (language === "python") {
      const m = line.match(/^\s*(?:from\s+(\S+)\s+import|import\s+(\S+))/);
      const mod = m?.[1] ?? m?.[2];
      if (mod) found.add(mod.replace(/,$/, ""));
      continue;
    }
    if (language === "go") {
      const m = line.match(/^\s*"([^"]+)"\s*$/);
      if (m?.[1]) found.add(m[1]);
      continue;
    }
    const m = line.match(/from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/);
    const mod = m?.[1] ?? m?.[2] ?? m?.[3];
    if (mod) found.add(mod);
  }
  return [...found].slice(0, 30);
}

function guessTestOwner(rel: string): string | undefined {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return rel;
  if (rel.endsWith("_test.go") || rel.endsWith("_test.py")) return rel;
  const withoutExt = rel.replace(/\.[^.]+$/, "");
  if (rel.includes("/src/")) {
    return rel.replace("/src/", "/").replace(/\.[^.]+$/, ".test.ts");
  }
  return `${withoutExt}.test.ts`;
}

function guessRules(rel: string): string[] | undefined {
  const rules: string[] = [];
  if (rel === "AGENTS.md" || rel.endsWith("/AGENTS.md")) rules.push(rel);
  if (rel === "CLAUDE.md" || rel.endsWith("/CLAUDE.md")) rules.push(rel);
  return rules.length > 0 ? rules : undefined;
}
