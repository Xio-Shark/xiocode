/**
 * Transcript search — pure helpers shared by the fullscreen window and the
 * route B review overlay. Matching is per flattened render line (the same
 * lines `sliceTranscriptLineWindow` slices), so a search hit is addressable
 * by a line index that both modes can jump to.
 */

import { stripAnsi } from "./text-selection.ts";
import type { HistoryBlock } from "./transcript-log.ts";

/**
 * Flatten blocks into plain (ANSI-stripped) line texts, top → bottom.
 * Empty blocks still contribute one addressable row, matching
 * `sliceTranscriptLineWindow`.
 */
export function transcriptFlatLines(blocks: readonly HistoryBlock[]): readonly string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    const source = block.lines.length > 0 ? block.lines : [""];
    for (const text of source) lines.push(stripAnsi(text));
  }
  return lines;
}

/**
 * 0-based line indexes (top → bottom) of every line whose visible text
 * contains `query` (case-insensitive). Empty query matches nothing.
 */
export function searchTranscriptLines(
  blocks: readonly HistoryBlock[],
  query: string,
): readonly number[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const results: number[] = [];
  transcriptFlatLines(blocks).forEach((text, index) => {
    if (text.toLowerCase().includes(needle)) results.push(index);
  });
  return results;
}

/**
 * Scroll offset (0 = bottom, same convention as `sliceTranscriptLineWindow`)
 * that places line `lineIndex` (top-based) as the bottom visible line.
 * Offset 0 is sticky-to-latest, so any line already at the bottom maps to 0.
 */
export function scrollOffsetForLine(totalLines: number, lineIndex: number): number {
  if (lineIndex >= totalLines) return 0;
  const offset = totalLines - 1 - lineIndex;
  return Math.max(0, offset);
}
