/**
 * In-app transcript text selection (Grok-style).
 *
 * Selection uses a **plain-text** line buffer (ANSI stripped) so mouse columns
 * match model output / markdown-styled assistant lines.
 *
 * UX (matches grok-build): press → drag (≥1 cell) → release copies. Bare click
 * does not copy; no separate "copy mode" / double-click gate.
 */

export type CellPos = Readonly<{ line: number; col: number }>;

export type TextSelectionRange = Readonly<{
  anchor: CellPos;
  head: CellPos;
}>;

/** Ordered start→end (end.col exclusive). */
export type OrderedSelection = Readonly<{
  start: CellPos;
  end: CellPos;
}>;

/** CSI / OSC / charset ANSI sequences that inflate string index vs terminal columns. */
const ANSI_RE = new RegExp(
  [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=]?)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=]*)*)?\\u0007)",
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  ].join("|"),
  "g",
);

export function stripAnsi(text: string): string {
  if (text.length === 0) return text;
  return text.replace(ANSI_RE, "");
}

/**
 * Terminal cell width of one code point (Grok uses unicode-width; we approximate
 * common CJK / fullwidth / emoji as 2 so mouse cols match Chinese model output).
 */
export function codePointDisplayWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  // Zero-width combining marks (common).
  if (codePoint >= 0x0300 && codePoint <= 0x036F) return 0;
  if (codePoint >= 0xFE00 && codePoint <= 0xFE0F) return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115F)
    || (codePoint >= 0x2E80 && codePoint <= 0xA4CF)
    || (codePoint >= 0xAC00 && codePoint <= 0xD7A3)
    || (codePoint >= 0xF900 && codePoint <= 0xFAFF)
    || (codePoint >= 0xFE10 && codePoint <= 0xFE19)
    || (codePoint >= 0xFE30 && codePoint <= 0xFE6F)
    || (codePoint >= 0xFF01 && codePoint <= 0xFF60)
    || (codePoint >= 0xFFE0 && codePoint <= 0xFFE6)
    || (codePoint >= 0x1F300 && codePoint <= 0x1FAFF)
    || (codePoint >= 0x20000 && codePoint <= 0x3FFFD)
  ) {
    return 2;
  }
  return 1;
}

/** Sum of terminal display columns for `text` (no ANSI). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += codePointDisplayWidth(ch.codePointAt(0)!);
  }
  return width;
}

/** Map a 0-based terminal display column into a UTF-16 string index. */
export function indexFromDisplayCol(text: string, displayCol: number): number {
  if (displayCol <= 0) return 0;
  let col = 0;
  let index = 0;
  for (const ch of text) {
    const w = codePointDisplayWidth(ch.codePointAt(0)!);
    if (col + w > displayCol) return index;
    col += w;
    index += ch.length;
    if (col >= displayCol) return index;
  }
  return text.length;
}

export function clampCell(pos: CellPos, lines: readonly string[]): CellPos {
  if (lines.length === 0) return { line: 0, col: 0 };
  const line = Math.max(0, Math.min(pos.line, lines.length - 1));
  const maxCol = lines[line]!.length;
  const col = Math.max(0, Math.min(pos.col, maxCol));
  return { line, col };
}

export function orderSelection(range: TextSelectionRange): OrderedSelection {
  const a = range.anchor;
  const b = range.head;
  if (a.line < b.line || (a.line === b.line && a.col <= b.col)) {
    return { start: a, end: b };
  }
  return { start: b, end: a };
}

export function selectionIsEmpty(range: TextSelectionRange): boolean {
  return range.anchor.line === range.head.line && range.anchor.col === range.head.col;
}

/** Manhattan-ish drag distance in cells (for click-vs-drag threshold). */
export function selectionDragDistance(range: TextSelectionRange): number {
  return Math.abs(range.head.line - range.anchor.line)
    + Math.abs(range.head.col - range.anchor.col);
}

/**
 * Extract selected text. End col is exclusive (like JS slice).
 * Multi-line joins with `\n`.
 */
export function extractSelectedText(
  lines: readonly string[],
  range: TextSelectionRange,
): string {
  if (lines.length === 0 || selectionIsEmpty(range)) return "";
  const { start, end } = orderSelection({
    anchor: clampCell(range.anchor, lines),
    head: clampCell(range.head, lines),
  });
  if (start.line === end.line) {
    return lines[start.line]!.slice(start.col, end.col);
  }
  const parts: string[] = [];
  parts.push(lines[start.line]!.slice(start.col));
  for (let i = start.line + 1; i < end.line; i += 1) {
    parts.push(lines[i]!);
  }
  parts.push(lines[end.line]!.slice(0, end.col));
  return parts.join("\n");
}

/**
 * Map 1-based SGR mouse (col, row) into a cell in the selectable line buffer.
 *
 * `contentTopRow` / `contentBottomRow` are 1-based inclusive band for transcript.
 * When `clampToBand` is true, rows inside the band but past the last line snap
 * to the end of the last line (empty flex space below short transcripts).
 */
export function cellFromMouse(input: Readonly<{
  col: number;
  row: number;
  contentTopRow: number;
  contentBottomRow?: number;
  lines: readonly string[];
  clampToBand?: boolean;
}>): CellPos | undefined {
  if (input.lines.length === 0) return undefined;
  const bottom = input.contentBottomRow ?? (input.contentTopRow + input.lines.length - 1);
  if (input.row < input.contentTopRow) return undefined;
  if (input.row > bottom) return undefined;

  let line = input.row - input.contentTopRow;
  const displayCol = Math.max(0, input.col - 1);
  if (line >= input.lines.length) {
    if (!input.clampToBand) return undefined;
    const last = input.lines.length - 1;
    return { line: last, col: input.lines[last]!.length };
  }
  const col = indexFromDisplayCol(input.lines[line]!, displayCol);
  return clampCell({ line, col }, input.lines);
}

/** Flatten history block display lines into a plain selectable buffer. */
export function flattenBlockLines(
  blocks: ReadonlyArray<Readonly<{ lines: readonly string[] }>>,
): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    for (const line of block.lines) out.push(stripAnsi(line));
  }
  return out;
}

/**
 * Split one display line into unselected / selected / unselected segments
 * for Ink `inverse` highlighting. `line` should already be plain (no ANSI).
 */
export function highlightLineSegments(
  line: string,
  lineIndex: number,
  range: TextSelectionRange | undefined,
): ReadonlyArray<Readonly<{ text: string; selected: boolean }>> | undefined {
  if (!range || selectionIsEmpty(range)) return undefined;
  const { start, end } = orderSelection(range);
  if (lineIndex < start.line || lineIndex > end.line) return undefined;

  let from = 0;
  let to = line.length;
  if (lineIndex === start.line) from = Math.min(start.col, line.length);
  if (lineIndex === end.line) to = Math.min(end.col, line.length);
  if (from >= to) {
    if (from === 0 && to === 0 && line.length === 0) return undefined;
    return [{ text: line, selected: false }];
  }

  const segments: Array<{ text: string; selected: boolean }> = [];
  if (from > 0) segments.push({ text: line.slice(0, from), selected: false });
  segments.push({ text: line.slice(from, to), selected: true });
  if (to < line.length) segments.push({ text: line.slice(to), selected: false });
  return segments;
}

/** Brand header ≈ 3 mark rows + margin; scroll hint adds 1 when present. */
export const DEFAULT_HEADER_ROWS = 4;
/** Composer border + prompt + footer ≈ last 6 rows. */
export const DEFAULT_CHROME_BOTTOM_ROWS = 6;

export function estimateContentTopRow(input: Readonly<{
  scrolled: boolean;
}>): number {
  // 1-based: row 1 is top of screen. Header occupies rows 1..HEADER.
  return DEFAULT_HEADER_ROWS + (input.scrolled ? 1 : 0) + 1;
}

export function estimateContentBottomRow(terminalRows: number): number {
  return Math.max(1, terminalRows - DEFAULT_CHROME_BOTTOM_ROWS);
}
