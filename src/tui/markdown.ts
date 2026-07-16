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

/** One shared alternation so strings/comments/numbers/keywords never nest styles. */
function codeTokenPattern(lang: string): RegExp {
  const comment = HASH_COMMENT_LANGS.has(lang) ? "#.*$" : "\\/\\/.*$";
  return new RegExp(
    `(${comment})`
    + `|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)`
    + `|\\b(\\d+(?:\\.\\d+)?)\\b`
    + `|\\b(${CODE_KEYWORDS})\\b`,
    "g",
  );
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
  if (heading) return md.bold(md.accent(renderInline(heading[2]!)));
  if (HRULE.test(line)) return md.muted("─".repeat(24));
  const bullet = BULLET.exec(line);
  if (bullet) return `${bullet[1]}${md.accent("•")} ${renderInline(bullet[2]!)}`;
  const ordered = ORDERED.exec(line);
  if (ordered) return `${ordered[1]}${md.accent(`${ordered[2]}${ordered[3]}`)} ${renderInline(ordered[4]!)}`;
  const quote = QUOTE.exec(line);
  if (quote) return `${md.muted("│")} ${md.dim(renderInline(quote[1]!))}`;
  return renderInline(line);
}

/**
 * Render markdown source to terminal lines (one entry per source line; no
 * hard wrapping — Ink wraps). Fence markers stay visible so copied code
 * blocks remain valid markdown.
 */
export function renderMarkdownLines(text: string): readonly string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const out: string[] = [];
  let fenceLang: string | undefined;
  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (fence) {
      fenceLang = fenceLang === undefined ? (fence[2] ?? "").toLowerCase() : undefined;
      out.push(md.muted(line));
      continue;
    }
    out.push(fenceLang !== undefined ? highlightCodeLine(line, fenceLang) : renderBlockLine(line));
  }
  return out;
}
