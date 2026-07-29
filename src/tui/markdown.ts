/**
 * Markdown → styled terminal lines for finalized assistant blocks.
 *
 * Runs only at block finalization (Static commit / restore), never in the
 * delta hot path — live streaming previews stay plain text.
 *
 * Contract: text with no markdown constructs passes through byte-identical
 * (tests assert finalized blocks contain the raw streamed text). Output lines
 * carry inline ANSI styles; Ink `Text` + wrap-ansi pass them through.
 *
 * Design informed by pi's markdown component (earendil-works/pi, MIT) — no
 * code copied; this is an independent line-based implementation.
 */

import { displayWidth, stripAnsi } from "./text-selection.ts";

const ESC = "\u001B[";

function style(open: string, close: string): (text: string) => string {
  return (text) => `${ESC}${open}m${text}${ESC}${close}m`;
}

export const md = {
  bold: style("1", "22"),
  dim: style("2", "22"),
  italic: style("3", "23"),
  // Slots follow theme semantics: accent=cyan, tool=yellow, brand=magenta.
  accent: style("36", "39"),
  string: style("32", "39"),
  number: style("33", "39"),
  keyword: style("35", "39"),
  muted: style("90", "39"),
} as const;

/** Languages whose line comments start with `#` (not `//`). */
const HASH_COMMENT_LANGS = new Set([
  "sh", "bash", "zsh", "shell", "python", "py", "yaml", "yml", "toml", "ruby", "rb", "make", "makefile",
]);

const CODE_KEYWORDS =
  "const|let|var|function|return|if|elif|else|for|while|switch|case|break|continue|"
  + "import|export|from|type|interface|class|extends|new|await|async|throw|try|catch|finally|"
  + "def|lambda|pass|raise|with|as|in|not|and|or|is|"
  + "null|undefined|true|false|None|True|False|void|this|self|static|readonly|enum";

/**
 * One shared alternation so strings/comments/numbers/keywords never nest styles.
 *
 * Cached per comment style: this runs once per line of every finalized code
 * block, and compiling the alternation each time showed up in the commit spike.
 * Reusing a `g` regex across calls is safe — `String.replace` resets
 * `lastIndex` itself.
 */
const CODE_TOKEN_PATTERNS = new Map<string, RegExp>();

function codeTokenPattern(lang: string): RegExp {
  const comment = HASH_COMMENT_LANGS.has(lang) ? "#.*$" : "\\/\\/.*$";
  const cached = CODE_TOKEN_PATTERNS.get(comment);
  if (cached) return cached;
  const pattern = new RegExp(
    `(${comment})`
    + `|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)`
    + `|\\b(\\d+(?:\\.\\d+)?)\\b`
    + `|\\b(${CODE_KEYWORDS})\\b`,
    "g",
  );
  CODE_TOKEN_PATTERNS.set(comment, pattern);
  return pattern;
}

export function highlightCodeLine(line: string, lang: string): string {
  return line.replace(codeTokenPattern(lang), (match, comment, str, num, kw) => {
    if (comment !== undefined) return md.muted(match);
    if (str !== undefined) return md.string(match);
    if (num !== undefined) return md.number(match);
    if (kw !== undefined) return md.keyword(match);
    return match;
  });
}

/** Inline styles for non-code text. No-op on text without markdown markers. */
export function renderInline(text: string): string {
  // Split out `code spans` first so other styles never apply inside them.
  const parts = text.split(/(`[^`\n]+`)/);
  let out = "";
  for (const part of parts) {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      out += md.accent(part.slice(1, -1));
      continue;
    }
    out += part
      .replace(/\*\*([^*\n]+)\*\*/g, (_, body: string) => md.bold(body))
      .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, (_, body: string) => md.italic(body))
      .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, (_, body: string) => md.italic(body))
      .replace(
        /\[([^\]\n]+)\]\(([^)\n]+)\)/g,
        (_, label: string, url: string) => `${label} ${md.muted(`(${url})`)}`,
      );
  }
  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)([.)])\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const HRULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*(```+|~~~+)\s*(\S*)\s*$/;

function renderBlockLine(line: string): string {
  const heading = HEADING.exec(line);
  if (heading) {
    // Depth has to be visible: `#` and `######` reading identically loses the
    // outline of any long answer. Accent carries the top two, bold the rest.
    const body = renderInline(heading[2]!);
    return heading[1]!.length <= 2 ? md.bold(md.accent(body)) : md.bold(body);
  }
  if (HRULE.test(line)) return md.muted("─".repeat(24));
  const bullet = BULLET.exec(line);
  if (bullet) return `${bullet[1]}${md.accent("•")} ${renderInline(bullet[2]!)}`;
  const ordered = ORDERED.exec(line);
  if (ordered) return `${ordered[1]}${md.accent(`${ordered[2]}${ordered[3]}`)} ${renderInline(ordered[4]!)}`;
  const quote = QUOTE.exec(line);
  if (quote) return `${md.muted("│")} ${md.dim(renderInline(quote[1]!))}`;
  return renderInline(line);
}

type CellAlign = "left" | "right" | "center";

/** GFM delimiter row: `|---|:--:|` and friends. Needs at least one dash cell. */
const TABLE_DELIMITER = /^\s*\|?(?:\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/;

/**
 * A padded table can only get wider than the source, so past this it would turn
 * a table that merely wraps into one that wraps worse. Leave those untouched.
 */
const TABLE_MAX_WIDTH = 160;

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

/** Split a pipe row into trimmed cells, tolerating optional outer pipes. */
function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function cellAlignments(delimiter: string): CellAlign[] {
  return splitTableRow(delimiter).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    return right ? "right" : "left";
  });
}

function padCell(styled: string, width: number, align: CellAlign): string {
  // Pad against the *visible* width: `**bold**` renders four columns, not eight.
  const slack = Math.max(0, width - displayWidth(stripAnsi(styled)));
  if (slack === 0) return styled;
  if (align === "right") return " ".repeat(slack) + styled;
  if (align === "center") {
    const left = Math.floor(slack / 2);
    return `${" ".repeat(left)}${styled}${" ".repeat(slack - left)}`;
  }
  return styled + " ".repeat(slack);
}

/**
 * Pad a pipe table so its columns line up, keeping `|` and `---` so the block
 * a user copies out is still valid markdown. Returns undefined when the table
 * is malformed or too wide to be worth padding — caller then leaves it alone.
 */
export function alignTableBlock(rows: readonly string[]): readonly string[] | undefined {
  if (rows.length < 2) return undefined;
  const header = splitTableRow(rows[0]!);
  const aligns = cellAlignments(rows[1]!);
  if (header.length < 2 || aligns.length !== header.length) return undefined;

  const body = rows.slice(2).map((row) => splitTableRow(row));
  const styled = [header, ...body].map((row) =>
    Array.from({ length: header.length }, (_, index) => renderInline(row[index] ?? "")));
  const widths = Array.from({ length: header.length }, (_, index) =>
    Math.max(3, ...styled.map((row) => displayWidth(stripAnsi(row[index]!)))));
  if (widths.reduce((sum, width) => sum + width + 3, 1) > TABLE_MAX_WIDTH) return undefined;

  const bar = md.muted("|");
  const line = (cells: readonly string[]): string =>
    `${bar} ${cells.map((cell, index) => padCell(cell, widths[index]!, aligns[index]!)).join(` ${bar} `)} ${bar}`;
  // Only center/right need a colon; bare dashes already mean left in GFM.
  const rule = widths.map((width, index) => {
    const align = aligns[index]!;
    const head = align === "center" ? ":" : "-";
    const tail = align === "center" || align === "right" ? ":" : "-";
    return md.muted(`${head}${"-".repeat(width - 2)}${tail}`);
  });
  return [line(styled[0]!), line(rule), ...styled.slice(1).map((row) => line(row))];
}

/**
 * True when a rendered line is a padded table row. Callers that prefix the
 * first line of a block need this: prefixing one row of a table breaks the
 * column alignment the padding just established.
 */
export function isRenderedTableRow(line: string): boolean {
  return stripAnsi(line).startsWith("| ");
}

/**
 * Render markdown source to terminal lines (one entry per source line, except
 * tables which stay row-per-line; no hard wrapping — Ink wraps). Fence markers
 * stay visible so copied code blocks remain valid markdown.
 */
export function renderMarkdownLines(text: string): readonly string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const out: string[] = [];
  let fenceLang: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = FENCE.exec(line);
    if (fence) {
      fenceLang = fenceLang === undefined ? (fence[2] ?? "").toLowerCase() : undefined;
      out.push(md.muted(line));
      continue;
    }
    if (fenceLang !== undefined) {
      out.push(highlightCodeLine(line, fenceLang));
      continue;
    }
    // Header + delimiter starts a table; consume rows until the block ends.
    const next = lines[index + 1];
    if (isTableRow(line) && next !== undefined && next.includes("|") && TABLE_DELIMITER.test(next)) {
      let end = index + 2;
      while (end < lines.length && isTableRow(lines[end]!) && !FENCE.test(lines[end]!)) end += 1;
      const aligned = alignTableBlock(lines.slice(index, end));
      if (aligned) {
        out.push(...aligned);
        index = end - 1;
        continue;
      }
    }
    out.push(renderBlockLine(line));
  }
  return out;
}
