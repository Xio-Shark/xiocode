/**
 * `@` file references for the composer.
 *
 * Pure helpers (token detection, fuzzy filter, insertion) plus two IO edges:
 * workspace file listing (git ls-files → bounded walk fallback) and
 * submit-time expansion of `@path` tokens into fenced file blocks.
 *
 * Expansion happens once at submit (runInput), never per keystroke; the
 * transcript shows the raw typed text, only the outgoing prompt is expanded.
 */

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ComposerState } from "./composer.ts";

const execFileAsync = promisify(execFile);

/** `@token` under the cursor: `@` at start or after whitespace, no spaces inside. */
const AT_TOKEN = /(^|\s)@([^\s@]*)$/;

/** Query text after `@` when the cursor sits in an active token, else undefined. */
export function atQuery(text: string, cursor: number): string | undefined {
  const match = AT_TOKEN.exec(text.slice(0, cursor));
  return match ? match[2] : undefined;
}

/**
 * Rank workspace paths against the query: substring beats subsequence,
 * basename hits beat directory hits, shorter paths win ties.
 */
export function filterFiles(
  files: readonly string[],
  query: string,
  limit = 50,
): readonly string[] {
  if (query.length === 0) return files.slice(0, limit);
  const needle = query.toLowerCase();
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score: number;
    if (base.startsWith(needle)) score = 0;
    else if (base.includes(needle)) score = 1;
    else if (lower.includes(needle)) score = 2;
    else if (isSubsequence(needle, lower)) score = 3;
    else continue;
    scored.push({ file, score });
  }
  scored.sort((a, b) => a.score - b.score || a.file.length - b.file.length || (a.file < b.file ? -1 : 1));
  return scored.slice(0, limit).map((entry) => entry.file);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of needle) {
    at = haystack.indexOf(char, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

/** Replace the active `@token` before the cursor with `@path ` (cursor lands after the space). */
export function insertFileMention(state: ComposerState, file: string): ComposerState {
  const before = state.text.slice(0, state.cursor);
  const match = AT_TOKEN.exec(before);
  if (!match) return state;
  const start = before.length - match[2]!.length - 1;
  const inserted = `@${file} `;
  const text = `${state.text.slice(0, start)}${inserted}${state.text.slice(state.cursor)}`;
  return { ...state, text, cursor: start + inserted.length, historyIndex: -1 };
}

const WALK_SKIP = new Set([".git", "node_modules", "dist", "build", "coverage", ".cache"]);
const WALK_MAX_FILES = 5_000;
const WALK_MAX_DEPTH = 8;

/**
 * Workspace file list for the picker. `git ls-files --cached --others
 * --exclude-standard` is the source of truth (.gitignore respected); non-git
 * directories fall back to a bounded walk that skips well-known build dirs.
 */
export async function listWorkspaceFiles(cwd: string): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd, maxBuffer: 32 * 1024 * 1024 },
    );
    const files = stdout.split("\0").filter((entry) => entry.length > 0);
    if (files.length > 0) return files;
  } catch {
    // Not a git repo (or git missing) — fall through to the bounded walk.
  }
  return walkFiles(cwd);
}

async function walkFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: root, rel: "", depth: 0 }];
  while (queue.length > 0 && files.length < WALK_MAX_FILES) {
    const current = queue.shift()!;
    let dirents;
    try {
      dirents = await readdir(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (files.length >= WALK_MAX_FILES) break;
      const rel = current.rel ? `${current.rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (WALK_SKIP.has(dirent.name) || dirent.name.startsWith(".")) continue;
        if (current.depth + 1 <= WALK_MAX_DEPTH) {
          queue.push({ abs: path.join(current.abs, dirent.name), rel, depth: current.depth + 1 });
        }
        continue;
      }
      if (dirent.isFile()) files.push(rel);
    }
  }
  return files.sort();
}

const EXPAND_PER_FILE_CHARS = 16_000;
const EXPAND_TOTAL_CHARS = 48_000;
/** `@path` tokens anywhere in the submitted text (same shape the picker inserts). */
const MENTION = /(^|\s)@([^\s@]+)/g;

/**
 * Expand `@path` mentions into appended `<file>` blocks (bounded). Tokens that
 * do not resolve to a readable file inside `root` are left untouched — `@user`
 * handles and typos never break the prompt. Returns the input unchanged when
 * nothing expands.
 */
export async function expandFileMentions(text: string, root: string): Promise<string> {
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    seen.add(match[2]!);
  }
  if (seen.size === 0) return text;
  const blocks: string[] = [];
  let budget = EXPAND_TOTAL_CHARS;
  for (const mention of seen) {
    if (budget <= 0) {
      blocks.push(`<file path="${mention}" skipped="total budget exhausted" />`);
      continue;
    }
    const resolved = path.resolve(root, mention);
    if (!resolved.startsWith(path.resolve(root) + path.sep)) continue;
    let content: string;
    try {
      content = await readFile(resolved, "utf8");
    } catch {
      continue;
    }
    const cap = Math.min(EXPAND_PER_FILE_CHARS, budget);
    const truncated = content.length > cap;
    const body = truncated ? content.slice(0, cap) : content;
    budget -= body.length;
    blocks.push(
      `<file path="${mention}"${truncated ? ` truncated="showing first ${cap} chars"` : ""}>\n${body}\n</file>`,
    );
  }
  if (blocks.length === 0) return text;
  return `${text}\n\nReferenced files:\n\n${blocks.join("\n\n")}`;
}
