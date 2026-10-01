/**
 * Transcript rendering: the live stream region, finalized history rows, the windowed line
 * view with search highlight, and the review overlay of the main-buffer route.
 */

import React, { memo, useRef } from "react";
import { Box, Text, useBoxMetrics } from "ink";

import { highlightLineSegments, stripAnsi, type TextSelectionRange } from "./text-selection.ts";
import {
  formatLiveLines,
  isExploreHistoryBlock,
  sliceTranscriptLineWindow,
  type HistoryBlock,
  type RenderLine,
  type ScrollbackState,
} from "./transcript-log.ts";
import { quietText, theme } from "./theme.ts";
import { t } from "../i18n/messages.ts";

const h = React.createElement;

/** Sticky live stream — only re-renders when live buffer / in-flight tools change. */
export const LiveStreamRegion = memo(function LiveStreamRegion(props: Readonly<{
  live: ScrollbackState["live"];
  inFlightTools: ScrollbackState["inFlightTools"];
  inFlightSubagents: ScrollbackState["inFlightSubagents"];
  charBudget?: number;
  now: number;
  spinnerFrame?: string;
}>): React.JSX.Element | null {
  const { live, inFlightTools, inFlightSubagents, charBudget, now, spinnerFrame } = props;
  const lines = formatLiveLines(live, inFlightTools, inFlightSubagents, {
    charBudget,
    now,
    spinnerFrame,
  });
  if (lines.length === 0) return null;

  const isAssistantStream = live?.kind === "assistant";
  const nonAssistantTailCount = inFlightTools.length + inFlightSubagents.length;
  const assistantCount = isAssistantStream ? Math.max(0, lines.length - nonAssistantTailCount) : 0;

  return h(Box, { flexDirection: "column", flexShrink: 0, marginTop: 1 },
    ...lines.map((line, index) => {
      const isAssistantLine = isAssistantStream && index < assistantCount;
      return h(Text, {
        key: `live-${index}`,
        wrap: "truncate-end",
        bold: false,
        ...quietText(!isAssistantLine && line.startsWith(`  ${theme.sym.tool} `) ? theme.tool : undefined, !isAssistantLine),
      }, line);
    }));
});

export const HistoryBlockRow = memo(function HistoryBlockRow(
  props: Readonly<{
    block: HistoryBlock;
    /** Flat selectable-line index of this block's first line (fullscreen select). */
    lineBase?: number;
    selection?: TextSelectionRange;
  }>,
): React.JSX.Element {
  const explore = isExploreHistoryBlock(props.block);
  const color = props.block.error
    ? theme.error
    : explore
      ? theme.explore
      : props.block.kind === "tool"
        ? theme.tool
        : props.block.kind === "thinking"
          ? theme.think
          : undefined;
  const bold = props.block.kind === "assistant";
  const dim = !props.block.error && (props.block.kind === "tool"
    || props.block.kind === "thinking"
    || props.block.kind === "notice"
    || props.block.kind === "subagent");
  const compact = props.block.kind === "tool"
    || props.block.kind === "thinking"
    || props.block.kind === "subagent";
  const lineBase = props.lineBase ?? 0;
  return h(Box, { flexDirection: "column", flexShrink: 0 },
    ...props.block.lines.map((rawLine, index) => {
      // Selection math is on plain text; render plain when highlighting so cols match.
      const plain = stripAnsi(rawLine);
      const segments = highlightLineSegments(plain, lineBase + index, props.selection);
      if (!segments) {
        return h(Text, {
          key: `${props.block.id}-${index}`,
          ...quietText(color, dim),
          bold: bold && index === 0,
          wrap: compact ? "truncate-end" : "wrap",
        }, rawLine);
      }
      return h(Text, {
        key: `${props.block.id}-${index}`,
        ...quietText(color, dim),
        bold: bold && index === 0,
        wrap: compact ? "truncate-end" : "wrap",
      },
        ...segments.map((seg, segIndex) =>
          h(Text, {
            key: `seg-${segIndex}`,
            inverse: seg.selected,
            ...(seg.selected ? { color: undefined, dimColor: false } : quietText(color, dim)),
          }, seg.text)));
    }));
});

/**
 * Search-in-transcript state shared by the fullscreen window and the route B
 * review overlay. `results` are top-based line indexes into the flattened
 * transcript (`transcriptFlatLines`); `index` points into `results`.
 */
export type SearchState = Readonly<{
  query: string;
  index: number;
  results: readonly number[];
}>;

/** One-line search input + match counter rendered above the transcript. */
export function SearchBar(props: Readonly<{
  search: SearchState;
  totalLines: number;
}>): React.JSX.Element {
  const { search } = props;
  const position = search.results.length > 0
    ? ` ${search.index + 1}/${search.results.length}`
    : " 0/0";
  return h(Box, { flexDirection: "row", gap: 1, marginY: 0 },
    h(Text, { color: theme.accent, bold: true }, `/${search.query}${position}`),
    h(Text, { color: theme.muted }, t("search.keys")));
}

/**
 * Route B review overlay: a self-managed scrolling window over the finalized
 * transcript (the terminal scrollback can't be keyboard-scrolled). Height is
 * measured with useBoxMetrics so it adapts to whatever room Ink leaves after
 * the Static history; the first frame renders 4 rows, then snaps to the real
 * viewport. `y` copies the block at the top of the window.
 */
export function ReviewOverlay(props: Readonly<{
  blocks: readonly HistoryBlock[];
  offset: number;
  columns?: number;
  search?: SearchState;
  folded?: ReadonlySet<number>;
  onOffset: (delta: number) => void;
}>): React.JSX.Element {
  const ref = useRef<React.ElementRef<typeof Box> | null>(null);
  const { height, width, hasMeasured } = useBoxMetrics(ref);
  // Border (2) + title row + hint row + optional search row.
  const viewport = hasMeasured ? Math.max(4, Math.floor(height) - 4) : 4;
  const contentWidth = Math.max(20, (hasMeasured && width ? Math.floor(width) - 4 : (props.columns ? props.columns - 4 : 76)));
  const window = sliceTranscriptLineWindow(props.blocks, viewport, props.offset, props.folded, contentWidth);
  const total = window.totalLines;
  const firstVisibleIndex = Math.max(0, total - window.offset - window.lines.length);
  const matchIndexes = new Set(props.search?.results ?? []);
  const currentLine = props.search !== undefined && props.search.results.length > 0
    ? props.search.results[props.search.index] ?? -1
    : -1;
  const title = total > viewport
    ? `Transcript · lines ${firstVisibleIndex + 1}–${firstVisibleIndex + window.lines.length}/${total}`
    : `Transcript · ${total} line${total === 1 ? "" : "s"}`;
  return h(Box, {
    ref,
    flexDirection: "column",
    flexGrow: 1,
    borderStyle: "round",
    borderColor: theme.muted,
    paddingX: 1,
    marginTop: 1,
  },
    h(Text, { bold: true }, `${theme.sym.brand} ${title}`),
    props.search
      ? h(SearchBar, { search: props.search, totalLines: total })
      : h(Text, { color: theme.muted }, "↑↓/PgUp/PgDn scroll · ctrl+f search · y copy · esc close"),
    ...window.lines.map((line, index) => {
      const globalIndex = firstVisibleIndex + index;
      const match = matchIndexes.has(globalIndex);
      return h(RenderLineRow, {
        key: `${line.blockId}-${line.indexInBlock}-${index}`,
        line,
        lineIndex: index,
        match,
        matchCurrent: match && globalIndex === currentLine,
      });
    }),
    window.hiddenBelow > 0
      ? h(Text, { color: theme.muted }, t("window.below", { count: window.hiddenBelow }))
      : null);
}

/** Full text of a block (retained output wins over the folded lines). */
export function blockFullText(block: HistoryBlock): string {
  return block.output ?? block.lines.join("\n");
}

/**
 * One flattened transcript row (fullscreen line-granular window).
 * Mirrors HistoryBlockRow styling; wraps only assistant/user/notice content.
 */
export const RenderLineRow = memo(function RenderLineRow(props: Readonly<{
  line: RenderLine;
  /** Index within the visible window = selectable-line index (mouse selection). */
  lineIndex: number;
  selection?: TextSelectionRange;
  /** Search hit highlight (plain-text row, no selection math). */
  match?: boolean;
  /** Current search result — accent background. */
  matchCurrent?: boolean;
}>): React.JSX.Element {
  const { line } = props;
  const color = line.error
    ? theme.error
    : line.explore
      ? theme.explore
      : line.kind === "tool"
        ? theme.tool
        : line.kind === "thinking"
          ? theme.think
          : undefined;
  const dim = !line.error && (line.kind === "tool"
    || line.kind === "thinking"
    || line.kind === "notice"
    || line.kind === "subagent");
  const wrap = line.compact ? "truncate-end" as const : "wrap" as const;
  if (props.match || props.matchCurrent) {
    return h(Text, {
      ...(props.matchCurrent ? { color: undefined, dimColor: false } : quietText(color, dim)),
      bold: line.boldFirst,
      wrap,
      backgroundColor: props.matchCurrent ? theme.accent : "#3d3d3d",
    }, line.text || " ");
  }
  // Selection math is on plain text; render plain when highlighting so cols match.
  const plain = stripAnsi(line.text);
  const segments = highlightLineSegments(plain, props.lineIndex, props.selection);
  if (!segments) {
    return h(Text, { ...quietText(color, dim), bold: line.boldFirst, wrap }, line.text || " ");
  }
  return h(Text, { ...quietText(color, dim), bold: line.boldFirst, wrap },
    ...segments.map((seg, segIndex) =>
      h(Text, {
        key: `seg-${segIndex}`,
        inverse: seg.selected,
        ...(seg.selected ? { color: undefined, dimColor: false } : quietText(color, dim)),
      }, seg.text)));
});

export function wrappedLineCount(text: string, columns: number): number {
  if (text.length === 0) return 0;
  const width = Math.max(8, columns);
  let total = 0;
  for (const line of text.split("\n")) {
    // Visual width ≈ code units; good enough for scroll budgeting.
    total += Math.max(1, Math.ceil(Math.max(line.length, 1) / width));
  }
  return total;
}

/**
 * Screen-bounded char budget for the live answer/thinking preview: at most
 * ~1/3 of the terminal (clamped 3–12 rows) × usable columns. Long streams keep
 * their full buffer; only the sticky preview is capped so it can never push
 * the composer/footer off screen (思考输出超出输入框).
 */
export function livePreviewCharBudget(rows: number, columns: number): number {
  const usableCols = Math.max(20, (columns || 80) - 2);
  const budgetRows = Math.max(3, Math.min(12, Math.floor(rows / 3)));
  return budgetRows * usableCols;
}
