import { createRequire } from "node:module";

import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useBoxMetrics, useInput, useWindowSize } from "ink";

import {
  scrollOffsetForLine,
  searchTranscriptLines,
  transcriptFlatLines,
} from "./transcript-search.ts";
import { fuzzyFilter } from "./fuzzy.ts";

import {
  formatExploreToolLabel,
  formatToolExpandHint,
  formatToolOutputForDisplay,
  isExploreToolName,
} from "../runtime/session-ui.ts";
import { copyTextToClipboard } from "./clipboard.ts";
import { attachMouseScrollListener, isMouseLeakChunk, stripMouseLeak } from "./mouse-scroll.ts";
import {
  atQuery,
  expandFileMentions,
  filterFiles,
  insertFileMention,
  listWorkspaceFiles,
} from "./file-mention.ts";
import {
  cellFromMouse,
  estimateContentBottomRow,
  estimateContentTopRow,
  extractSelectedText,
  highlightLineSegments,
  selectionDragDistance,
  selectionIsEmpty,
  stripAnsi,
  type TextSelectionRange,
} from "./text-selection.ts";
import { CONTEXT_SUMMARY_NAME, isContextCompactionError } from "../runtime/context-compaction.ts";
import { SESSION_RECOVERY_NAME } from "../runtime/session-recovery.ts";
import type { PreparedSession } from "../runtime/session.ts";
import type { SelectChoice } from "../runtime/interactive-io.ts";
import type { TuiEvent, TuiSessionBridge } from "./session-bridge.ts";
import {
  applyInputChunk,
  clearQueue,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  deleteWordForward,
  emptyComposer,
  historyDown,
  historyUp,
  killToCursor,
  loadQueueIntoDraft,
  moveCursor,
  moveCursorLine,
  moveCursorTo,
  moveCursorWord,
  parseBusySubmitIntent,
  queueWhileBusy,
  rememberSubmission,
  setComposerText,
  sliceViewerWindow,
  type ComposerState,
} from "./composer.ts";
import {
  adjacentExpandableHistoryBlock,
  appendUserBlock,
  blocksFromRestoredMessages,
  emptyScrollbackState,
  expandableHistoryBlocks,
  formatLiveLines,
  formatSubagentActivity,
  isExploreHistoryBlock,
  latestExpandableToolBlock,
  liveTextTail,
  reduceScrollback,
  sliceTranscriptLineWindow,
  type HistoryBlock,
  type InFlightSubagent,
  type RenderLine,
  type ScrollbackState,
} from "./transcript-log.ts";
import { createDeltaCoalescer, mergeSoftDeltas } from "./delta-coalesce.ts";
import { motionEnabled, REDUCED_TICK_MS, SPINNER_INTERVAL_MS, spinnerFrameAt } from "./motion.ts";
import type { ChatMessage, ContextCompactionUiEvent } from "../runtime/types.ts";
import {
  collapseNoticesForDisplay,
  formatShortCwd,
  padSlashName,
  theme,
  truncateToolDetail,
} from "./theme.ts";
import { composerHint, shortcutGroups, ShortcutsOverlay } from "./shortcuts.ts";
import { BrandHeader } from "./shark-logo.ts";

const h = React.createElement;
const require = createRequire(import.meta.url);
const PACKAGE_VERSION = (() => {
  try {
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

type TranscriptEntry = Readonly<{
  id: number;
  kind: "user" | "assistant" | "tool" | "notice" | "command" | "thinking";
  text: string;
  error?: boolean;
  collapsed?: boolean;
  previewCollapsed?: boolean;
  title?: string;
  detail?: string;
  output?: string;
  /** Provider tool_call id — pairs tool-start/end when multiple same-name tools run. */
  callId?: string;
  startedAt?: number;
  thoughtSeconds?: number;
}>;

export type ViewState = Readonly<{
  entries: readonly TranscriptEntry[];
  statuses: Readonly<Record<string, string>>;
  /** Sticky panels keyed by widget id (e.g. tasklist). */
  widgets: Readonly<Record<string, readonly string[]>>;
  confirm?: Readonly<{ question: string; detail: string; scroll: number }>;
  select?: Readonly<{ question: string; choices: readonly SelectChoice[]; selected: number }>;
  prompt?: Readonly<{ question: string; secret: boolean; value: string }>;
}>;

export type AppProps = Readonly<{
  session: PreparedSession;
  bridge: TuiSessionBridge;
  cwd: string;
  onExit: (code: number) => Promise<void>;
  /**
   * Route B (interactive `xio`): finalized transcript via Ink `<Static>` into the
   * main buffer (native wheel/search). Tests keep `false` for on-tree transcript rows.
   */
  appendScrollback?: boolean;
  /** Draft drained from the interactive boot shell (pre-prompt_ready typing). */
  initialDraft?: string;
  /** When true, submit initialDraft once after mount (user pressed Enter during boot). */
  autoSubmitInitial?: boolean;
}>;

import {
  BUILTIN_SLASH_COMMANDS,
  CommandPalette,
  ConfirmView,
  FileMenu,
  FooterHints,
  SLASH_MENU_VISIBLE,
  SlashMenu,
  SubagentDetailOverlay,
  TasklistPanel,
  TranscriptViewerOverlay,
  VIEWER_CHROME_ROWS,
  collectSlashCommands,
  filterSlashCommands,
  formatExploreFooter,
  formatMcpFooter,
  formatWorkspaceFooter,
  isDefaultPermissionMode,
  slashQuery,
  viewerScrollBounds,
  type SlashCommand,
} from "./overlays.ts";

export type { SlashCommand };


/** Process-wide reduced-motion preference (TERM=dumb / XIO_ANIMATION=off). */
const MOTION_ENABLED = motionEnabled();

/** What lives on one visible terminal row of the fullscreen content band (double-click hit-test). */
export type LineTarget = Readonly<
  | { type: "block"; blockId: number }
  | { type: "hint" }
  | { type: "live" }
  | { type: "subagent"; workerId: number }
>;

/** Max ms between two presses on the same row to count as a double-click. */
export const DOUBLE_CLICK_MS = 450;

export function App(props: AppProps): React.JSX.Element {
  const { columns, rows } = useWindowSize();
  const appendScrollback = props.appendScrollback === true;
  const [view, setView] = useState<ViewState>(() =>
    ({ entries: [], statuses: {}, widgets: {} }),
  );
  // Canonical transcript for Static (route B) and windowed fullscreen (route A).
  const [scrollback, setScrollback] = useState<ScrollbackState>(() =>
    blocksFromRestoredMessages(props.session.getMessages()),
  );
  const [subagentClock, setSubagentClock] = useState(() => Date.now());
  // Fullscreen / Route A: 0 = stick to latest; >0 = lines scrolled up.
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    const applyBridgeEvent = (event: TuiEvent) => {
      if (
        event.kind === "status"
        || event.kind === "widget"
        || event.kind === "confirm-open"
        || event.kind === "confirm-close"
        || event.kind === "select-open"
        || event.kind === "select-close"
        || event.kind === "prompt-open"
        || event.kind === "prompt-close"
        || event.kind === "context-compaction"
      ) {
        setView((current) => reduceEvent(current, event));
        // Compaction also projects a transcript notice (start/success/fail).
        if (event.kind === "context-compaction") {
          setScrollback((current) => reduceScrollback(current, event));
        }
        return;
      }
      setScrollback((current) => reduceScrollback(current, event));
    };

    const coalescer = createDeltaCoalescer((events) => {
      const batch = mergeSoftDeltas(events);
      for (const event of batch) applyBridgeEvent(event);
    });

    const unsubscribe = props.bridge.subscribe((event) => {
      coalescer.push(event);
    });
    return () => {
      coalescer.dispose();
      unsubscribe();
    };
  }, [props.bridge]);

  // In-app drag-select (fullscreen only). Line buffer / content-top updated after window calc.
  const [textSelection, setTextSelection] = useState<TextSelectionRange | undefined>(undefined);
  const textSelectionRef = useRef(textSelection);
  textSelectionRef.current = textSelection;
  const selectableLinesRef = useRef<string[]>([]);
  const contentTopRowRef = useRef(1);
  const contentBottomRowRef = useRef(1);
  const dragActiveRef = useRef(false);
  const selectionFlashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lineTargetsRef = useRef<readonly LineTarget[]>([]);
  const selectionApiRef = useRef({
    selectableLinesRef,
    contentTopRowRef,
    contentBottomRowRef,
    textSelectionRef,
    dragActiveRef,
    selectionFlashTimer,
    lineTargetsRef,
    setTextSelection,
    clearTextSelection: () => {},
    finishTextSelectionCopy: (_range: TextSelectionRange) => {},
  });

  selectionApiRef.current.clearTextSelection = () => {
    if (selectionFlashTimer.current) {
      clearTimeout(selectionFlashTimer.current);
      selectionFlashTimer.current = undefined;
    }
    dragActiveRef.current = false;
    setTextSelection(undefined);
  };

  selectionApiRef.current.finishTextSelectionCopy = (range: TextSelectionRange) => {
    const lines = selectableLinesRef.current;
    const text = extractSelectedText(lines, range);
    dragActiveRef.current = false;
    if (text.length === 0 || selectionIsEmpty(range)) {
      setTextSelection(undefined);
      return;
    }
    const result = copyTextToClipboard(text);
    setTextSelection(range);
    if (selectionFlashTimer.current) clearTimeout(selectionFlashTimer.current);
    selectionFlashTimer.current = setTimeout(() => {
      setTextSelection(undefined);
      selectionFlashTimer.current = undefined;
    }, 800);
    // Status only — never notify (notices push scrollback and break hit-testing).
    props.bridge.sink.setStatus?.(
      "clipboard",
      result.ok ? `copied ${text.length}` : "copy failed",
    );
    setTimeout(() => {
      props.bridge.sink.setStatus?.("clipboard", undefined);
    }, 1200);
  };
  selectionApiRef.current.setTextSelection = setTextSelection;

  const {
    input,
    composer,
    busy,
    slashIndex,
    setSlashIndex,
    atItems,
    atIndex,
    transcriptViewer,
    viewerScrollOffset,
    setTranscriptViewer,
    focusedSubagentId,
    setFocusedSubagentId,
    review,
    search,
    palette,
    foldedBlockIds,
    escArmed,
    shortcutsOpen,
    shortcutsOffset,
    setReview,
  } = useSessionInteraction(
    props,
    setView,
    setScrollOffset,
    appendScrollback,
    setScrollback,
    scrollback,
    selectionApiRef,
    rows,
    scrollOffset,
  );

  // One animation clock drives all motion: spinner chrome at ~8fps while busy,
  // 1s ticks under reduced motion (subagent elapsed labels still advance).
  useEffect(() => {
    if (!busy && scrollback.inFlightSubagents.length === 0) return;
    const tickMs = MOTION_ENABLED ? SPINNER_INTERVAL_MS : REDUCED_TICK_MS;
    setSubagentClock(Date.now());
    const timer = setInterval(() => setSubagentClock(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [busy, scrollback.inFlightSubagents.length]);
  const spinnerFrame = MOTION_ENABLED && busy ? spinnerFrameAt(subagentClock) : undefined;

  const slashItems = useMemo(
    () => filterSlashCommands(collectSlashCommands(props.session.host), slashQuery(input)),
    [props.session.host, input],
  );
  const slashOpen = !busy && slashItems !== undefined;
  const safeSlashIndex = slashOpen && slashItems.length > 0
    ? Math.min(slashIndex, slashItems.length - 1)
    : 0;
  const atOpen = !slashOpen && atItems !== undefined;
  const safeAtIndex = atOpen && atItems.length > 0 ? Math.min(atIndex, atItems.length - 1) : 0;

  const tasklist = view.widgets.tasklist;
  const viewerHistory = transcriptViewer ? expandableHistoryBlocks(scrollback) : [];
  const viewerIndex = transcriptViewer
    ? viewerHistory.findIndex((block) => block.id === transcriptViewer.id)
    : -1;

  // --- Fullscreen / Route A: self-managed line-granular window over HistoryBlocks ---
  const window = useMemo(() => {
    if (appendScrollback) {
      return {
        lines: [] as readonly RenderLine[],
        offset: 0,
        maxOffset: 0,
        hiddenAbove: 0,
        hiddenBelow: 0,
        totalLines: 0,
      };
    }
    const tasklistRows = tasklist && tasklist.length > 0 ? Math.min(tasklist.length, 10) + 3 : 0;
    const menuRows = palette
      ? Math.min(SLASH_MENU_VISIBLE, 8) + 2
      : slashOpen
        ? Math.min(SLASH_MENU_VISIBLE, slashItems?.length ?? 0) + 2
        : atOpen
          ? Math.min(SLASH_MENU_VISIBLE, atItems?.length ?? 0) + 2
          : 0;
    // Live preview is screen-bounded; count wrapped rows so history + live +
    // chrome never exceed the terminal (overflow = un-erasable residue).
    const liveExtra = formatLiveLines(
      scrollback.live,
      scrollback.inFlightTools,
      scrollback.inFlightSubagents,
      { charBudget: livePreviewCharBudget(rows, columns) },
    ).reduce((sum, line) =>
      sum + (line.startsWith(`${theme.sym.answer} `)
        ? wrappedLineCount(line, Math.max(20, columns))
        : 1), 0);
    // Brand header (5 incl. margin) + composer/candidate border (4) + footer (2) = 11
    // chrome rows. The ↑ above / ↓ to latest hints render inside the content
    // band, so reserve their rows when scrolled: without this the window + hints
    // overflow the band and ink drops children (a visible line disappears).
    const hintRows = scrollOffset > 0 ? 2 : 0;
    const baseChrome = 11 + menuRows + tasklistRows + liveExtra + hintRows;
    const viewportLines = Math.max(4, rows - baseChrome);
    return sliceTranscriptLineWindow(scrollback.blocks, viewportLines, scrollOffset, foldedBlockIds);
  }, [
    appendScrollback,
    scrollback.blocks,
    scrollback.live,
    scrollback.inFlightTools,
    scrollback.inFlightSubagents,
    rows,
    columns,
    scrollOffset,
    palette,
    slashOpen,
    slashItems,
    atOpen,
    atItems,
    tasklist,
    foldedBlockIds,
  ]);

  useEffect(() => {
    if (appendScrollback) return;
    if (scrollOffset > window.maxOffset) {
      setScrollOffset(window.maxOffset);
    }
  }, [appendScrollback, scrollOffset, window.maxOffset]);

  const modelLabel = view.statuses.model ?? `${props.session.getModel().provider}/${props.session.getModel().id}`;
  const thinkingLabel = view.statuses.thinking ?? `think:${props.session.getThinkingLevel()}`;
  const permissionMode = props.session.getPermissionMode();
  const planLabel = view.statuses.plan;
  const workspaceLabel = view.statuses.workspace
    ?? view.statuses.isolation
    ?? undefined;
  const scrolled = !appendScrollback && window.offset > 0;

  // Running worker focused via double-click; falls back to its history block once finished.
  const focusedWorker = focusedSubagentId !== undefined
    ? scrollback.inFlightSubagents.find((worker) => worker.workerId === focusedSubagentId)
    : undefined;
  useEffect(() => {
    if (focusedSubagentId === undefined) return;
    if (scrollback.inFlightSubagents.some((worker) => worker.workerId === focusedSubagentId)) return;
    const block = scrollback.blocks.find(
      (candidate) => candidate.kind === "subagent" && candidate.workerId === focusedSubagentId,
    );
    setFocusedSubagentId(undefined);
    if (block) setTranscriptViewer(block);
  }, [focusedSubagentId, scrollback.inFlightSubagents, scrollback.blocks]);

  selectableLinesRef.current = appendScrollback
    ? []
    : window.lines.map((line) => stripAnsi(line.text));
  contentTopRowRef.current = estimateContentTopRow({ scrolled });
  contentBottomRowRef.current = estimateContentBottomRow(rows);
  // Row → target map for double-click: transcript lines, then hint, then live rows
  // (the last inFlightSubagents.length live rows are worker rows, in order).
  lineTargetsRef.current = appendScrollback
    ? []
    : (() => {
      const targets: LineTarget[] = window.lines.map((line) => ({
        type: "block",
        blockId: line.blockId,
      }));
      if (window.hiddenBelow > 0) targets.push({ type: "hint" });
      const liveCount = formatLiveLines(
        scrollback.live,
        scrollback.inFlightTools,
        scrollback.inFlightSubagents,
      ).length;
      const nonWorker = liveCount - scrollback.inFlightSubagents.length;
      for (let i = 0; i < nonWorker; i += 1) targets.push({ type: "live" });
      for (const worker of scrollback.inFlightSubagents) {
        targets.push({ type: "subagent", workerId: worker.workerId });
      }
      return targets;
    })();

  // Scrollback mode: natural height (Static history + chrome). Do not pin to full screen.
  // Fullscreen clips overflow: a frame taller than the terminal scrolls Ink's
  // managed region and leaves un-erasable residue after overlays close (Esc).
  const rootProps = appendScrollback
    ? { flexDirection: "column" as const }
    : { flexDirection: "column" as const, height: rows, overflow: "hidden" as const };

  return h(Box, rootProps,
    h(SessionHeader, {
      version: PACKAGE_VERSION,
      model: modelLabel,
      thinking: thinkingLabel,
      plan: planLabel,
      cwd: props.cwd,
      busy,
      phase: composePhaseChrome(busyPhaseLabel({
        busy,
        inFlightToolCount: scrollback.inFlightTools.length,
        inFlightSubagentCount: scrollback.inFlightSubagents.length,
        liveKind: scrollback.live?.kind,
      }), spinnerFrame),
    }),
    appendScrollback
      ? h(Static as React.FC<{ items: HistoryBlock[]; children: (block: HistoryBlock) => React.ReactNode }>, {
        // Ink Static mutates its items prop type; blocks array is only replaced on hard boundaries.
        items: scrollback.blocks as HistoryBlock[],
        children: (block: HistoryBlock) => h(HistoryBlockRow, { key: block.id, block }),
      })
      : null,
    appendScrollback && review
      ? h(ReviewOverlay, {
        blocks: scrollback.blocks,
        offset: review.offset,
        search,
        folded: foldedBlockIds,
        onOffset: (delta) => setReview((current) => ({
          ...(current ?? { offset: 0 }),
          offset: Math.max(0, (current?.offset ?? 0) + delta),
        })),
      })
      : null,
    transcriptViewer
      ? h(TranscriptViewerOverlay, {
        block: transcriptViewer,
        rows,
        scrollOffset: viewerScrollOffset,
        historyIndex: viewerIndex >= 0 ? viewerIndex + 1 : undefined,
        historyTotal: viewerHistory.length,
        onClose: () => setTranscriptViewer(undefined),
      })
      : shortcutsOpen
        ? h(ShortcutsOverlay, {
          groups: shortcutGroups({ fullscreen: !appendScrollback }),
          rows,
          scrollOffset: shortcutsOffset,
          commandCount: collectSlashCommands(props.session.host).length,
        })
        : focusedWorker
        ? h(SubagentDetailOverlay, {
          worker: focusedWorker,
          rows,
          now: subagentClock,
        })
        : view.confirm
          ? h(ConfirmView, { confirm: view.confirm, rows })
          : view.select
            ? h(SelectView, { select: view.select, rows })
            : view.prompt
              ? h(PromptView, { prompt: view.prompt })
              : h(Box, { flexDirection: "column", flexGrow: 1 },
                search && !appendScrollback
                  ? h(SearchBar, { search, totalLines: window.totalLines })
                  : null,
                !appendScrollback && scrolled
                  ? h(Text, { dimColor: true },
                    `↑ ${window.hiddenAbove} lines above · PgUp/PgDn · ↓ latest`)
                  : null,
                ...(!appendScrollback
                  ? window.lines.map((line, index) =>
                    h(RenderLineRow, {
                      key: `${line.blockId}-${line.indexInBlock}`,
                      line,
                      lineIndex: index,
                      selection: textSelection,
                    }))
                  : []),
                !appendScrollback && window.hiddenBelow > 0
                  ? h(Text, { dimColor: true }, `↓ ${window.hiddenBelow} lines to latest`)
                  : null,
                h(LiveStreamRegion, {
                  live: scrollback.live,
                  inFlightTools: scrollback.inFlightTools,
                  inFlightSubagents: scrollback.inFlightSubagents,
                  charBudget: livePreviewCharBudget(rows, columns),
                  now: subagentClock,
                  spinnerFrame,
                })),
    tasklist && tasklist.length > 0
      ? h(TasklistPanel, { lines: tasklist.slice(0, 10) })
      : null,
    h(InputCandidateRegion, {
      candidateMenu: palette
        ? h(CommandPalette, {
          query: palette.query,
          selected: palette.index,
          entries: collectSlashCommands(props.session.host),
        })
        : slashOpen
          ? h(SlashMenu, { items: slashItems ?? [], selected: safeSlashIndex })
          : atOpen
            ? h(FileMenu, { items: atItems ?? [], selected: safeAtIndex })
            : null,
      composer: h(ComposerChrome, {
        busy,
        spinnerFrame,
        composer: view.prompt ? { ...composer, text: maskPromptDisplay(view.prompt), cursor: maskPromptDisplay(view.prompt).length } : composer,
        hint: composerHint({
          busy,
          armed: escArmed,
          queued: composer.queue !== undefined,
          canSteer: typeof props.session.steer === "function",
        }),
        noBorder: true,
      }),
      active: composer.text.length > 0 || slashOpen || atOpen || Boolean(palette),
      busy,
    }),
    h(FooterHints, {
      permissionMode,
      cwd: props.cwd,
      context: view.statuses.clipboard ?? view.statuses.context,
      usage: view.statuses.usage,
      explore: view.statuses.explore,
      workspace: workspaceLabel,
      mcp: view.statuses.mcp,
      turn: scrollback.blocks.filter((block) => block.kind === "user").length,
    }));
}

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
  return h(Box, { flexDirection: "column", flexShrink: 0, marginTop: 1 },
    ...lines.map((line, index) =>
      h(Text, {
        key: `live-${index}`,
        wrap: "truncate-end",
        dimColor: !line.startsWith(`${theme.sym.answer} `),
        bold: line.startsWith(`${theme.sym.answer} `),
        color: line.startsWith(`${theme.sym.answer} `)
          ? theme.accent
          : line.startsWith(`  ${theme.sym.tool} `)
            ? theme.tool
            : undefined,
      }, line)));
});

/**
 * Unified input and candidate region bounded by two horizontal lines (top and bottom).
 * Eliminates enclosing boxes for a sleek, modern, boundary-free terminal aesthetic.
 */
export function InputCandidateRegion(props: Readonly<{
  candidateMenu?: React.JSX.Element | null;
  composer: React.JSX.Element;
  active: boolean;
  busy: boolean;
}>): React.JSX.Element {
  return h(Box, {
    flexDirection: "column",
    borderStyle: "single",
    borderTop: true,
    borderBottom: true,
    borderLeft: false,
    borderRight: false,
    borderColor: props.busy ? "gray" : (props.active ? theme.accent : "gray"),
    paddingX: 1,
    marginTop: 0,
    marginBottom: 0,
  },
    props.candidateMenu ?? null,
    props.composer);
}

/** Composer with block cursor and multiline draft (pi Editor-style subset). */
export const ComposerChrome = memo(function ComposerChrome(props: Readonly<{
  composer: ComposerState;
  busy: boolean;
  spinnerFrame?: string;
  /** Contextual hint line (esc cancel / double-esc clear / steer / queued). */
  hint?: string;
  /** When true, omits outer box borders (delegated to InputCandidateRegion). */
  noBorder?: boolean;
}>): React.JSX.Element {
  const { text, cursor } = props.composer;
  const lines = text.length === 0 ? [""] : text.split("\n");
  let offset = 0;
  const promptSymbol = props.busy ? (props.spinnerFrame ?? theme.sym.busy) : theme.sym.prompt;
  const rows = lines.map((line, rowIndex) => {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    if (rowIndex < lines.length - 1) offset = lineEnd + 1;
    else offset = lineEnd;
    const onCursorLine = cursor >= lineStart && cursor <= lineEnd;
    const prefix = rowIndex === 0 ? `${promptSymbol} ` : "  ";
    const prefixElement = h(Text, { color: props.busy ? "gray" : theme.accent, bold: true }, prefix);
    if (!onCursorLine) {
      return h(Text, { key: `composer-${rowIndex}`, wrap: "wrap" },
        prefixElement,
        line);
    }
    const col = cursor - lineStart;
    const before = line.slice(0, col);
    const after = line.slice(col);
    const cursorChar = after.length > 0 ? after.charAt(0) : " ";
    const rest = after.length > 1 ? after.slice(1) : "";
    return h(Text, { key: `composer-${rowIndex}`, wrap: "wrap" },
      prefixElement,
      before,
      h(Text, { inverse: true, color: theme.accent }, cursorChar),
      rest,
      text.length === 0 && !props.busy
        ? h(Text, { dimColor: true }, " Ask a question, / for commands, or paste code…")
        : null);
  });

  const content = [
    ...rows,
    props.hint
      ? h(Text, { dimColor: true }, `${theme.sym.nest} ${props.hint}`)
      : null,
  ];

  if (props.noBorder) {
    return h(Box, {
      marginTop: 0,
      marginBottom: 0,
      flexDirection: "column",
    }, ...content);
  }

  return h(Box, {
    marginTop: 0,
    marginBottom: 0,
    flexDirection: "column",
    borderStyle: "single",
    borderTop: true,
    borderBottom: true,
    borderLeft: false,
    borderRight: false,
    borderColor: props.busy ? "gray" : (text.length > 0 ? theme.accent : "gray"),
    paddingX: 1,
  }, ...content);
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
          color,
          bold: bold && index === 0,
          dimColor: dim,
          wrap: compact ? "truncate-end" : "wrap",
        }, rawLine);
      }
      return h(Text, {
        key: `${props.block.id}-${index}`,
        color,
        bold: bold && index === 0,
        dimColor: dim,
        wrap: compact ? "truncate-end" : "wrap",
      },
        ...segments.map((seg, segIndex) =>
          h(Text, {
            key: `seg-${segIndex}`,
            inverse: seg.selected,
            color: seg.selected ? undefined : color,
            dimColor: seg.selected ? false : dim,
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
function SearchBar(props: Readonly<{
  search: SearchState;
  totalLines: number;
}>): React.JSX.Element {
  const { search } = props;
  const position = search.results.length > 0
    ? ` ${search.index + 1}/${search.results.length}`
    : " 0/0";
  return h(Box, { flexDirection: "row", gap: 1, marginY: 0 },
    h(Text, { color: theme.accent, bold: true }, `/${search.query}${position}`),
    h(Text, { dimColor: true }, "enter/↓ next · ↑ prev · esc close"));
}

/**
 * Route B review overlay: a self-managed scrolling window over the finalized
 * transcript (the terminal scrollback can't be keyboard-scrolled). Height is
 * measured with useBoxMetrics so it adapts to whatever room Ink leaves after
 * the Static history; the first frame renders 4 rows, then snaps to the real
 * viewport. `y` copies the block at the top of the window.
 */
function ReviewOverlay(props: Readonly<{
  blocks: readonly HistoryBlock[];
  offset: number;
  search?: SearchState;
  folded?: ReadonlySet<number>;
  onOffset: (delta: number) => void;
}>): React.JSX.Element {
  const ref = useRef<React.ElementRef<typeof Box> | null>(null);
  const { height, hasMeasured } = useBoxMetrics(ref);
  // Border (2) + title row + hint row + optional search row.
  const viewport = hasMeasured ? Math.max(4, Math.floor(height) - 4) : 4;
  const window = sliceTranscriptLineWindow(props.blocks, viewport, props.offset, props.folded);
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
    borderColor: "gray",
    paddingX: 1,
    marginTop: 1,
  },
    h(Text, { bold: true }, `${theme.sym.brand} ${title}`),
    props.search
      ? h(SearchBar, { search: props.search, totalLines: total })
      : h(Text, { dimColor: true }, "↑↓/PgUp/PgDn scroll · ctrl+f search · y copy · esc close"),
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
      ? h(Text, { dimColor: true }, `↓ ${window.hiddenBelow} lines to latest`)
      : null);
}

/** Full text of a block (retained output wins over the folded lines). */
function blockFullText(block: HistoryBlock): string {
  return block.output ?? block.lines.join("\n");
}

/**
 * One flattened transcript row (fullscreen line-granular window).
 * Mirrors HistoryBlockRow styling; wraps only assistant/user/notice content.
 */
const RenderLineRow = memo(function RenderLineRow(props: Readonly<{
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
      color: props.matchCurrent ? undefined : color,
      bold: line.boldFirst,
      dimColor: props.matchCurrent ? false : dim,
      wrap,
      backgroundColor: props.matchCurrent ? theme.accent : "#3d3d3d",
    }, line.text || " ");
  }
  // Selection math is on plain text; render plain when highlighting so cols match.
  const plain = stripAnsi(line.text);
  const segments = highlightLineSegments(plain, props.lineIndex, props.selection);
  if (!segments) {
    return h(Text, { color, bold: line.boldFirst, dimColor: dim, wrap }, line.text || " ");
  }
  return h(Text, { color, bold: line.boldFirst, dimColor: dim, wrap },
    ...segments.map((seg, segIndex) =>
      h(Text, {
        key: `seg-${segIndex}`,
        inverse: seg.selected,
        color: seg.selected ? undefined : color,
        dimColor: seg.selected ? false : dim,
      }, seg.text)));
});

/**
 * Window into the transcript for alternate-screen (no terminal scrollback).
 * offset=0 → latest (bottom); offset increases as the user scrolls up (in **lines**).
 *
 * @param lineHeight per-entry terminal row estimate (default 1 = legacy entry-count mode)
 */
export function sliceTranscriptWindow<T>(
  entries: readonly T[],
  viewport: number,
  offset: number,
  lineHeight: (entry: T, index: number) => number = () => 1,
): Readonly<{
  visible: readonly T[];
  offset: number;
  maxOffset: number;
  hiddenAbove: number;
  hiddenBelow: number;
  viewport: number;
  totalLines: number;
}> {
  const size = Math.max(1, viewport);
  if (entries.length === 0) {
    return {
      visible: [],
      offset: 0,
      maxOffset: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
      viewport: size,
      totalLines: 0,
    };
  }

  const heights = entries.map((entry, index) => Math.max(1, Math.floor(lineHeight(entry, index))));
  let totalLines = 0;
  for (const hgt of heights) totalLines += hgt;

  const maxOffset = Math.max(0, totalLines - size);
  const clamped = Math.max(0, Math.min(offset, maxOffset));

  // Skip `clamped` lines from the bottom, then fill upward up to `size` lines.
  let skip = clamped;
  let endExclusive = entries.length;
  while (endExclusive > 0 && skip > 0) {
    const hgt = heights[endExclusive - 1]!;
    if (skip >= hgt) {
      skip -= hgt;
      endExclusive -= 1;
    } else {
      // Partial skip of the bottom-most visible entry: still include the whole entry.
      skip = 0;
    }
  }

  let used = 0;
  let start = endExclusive;
  while (start > 0) {
    const hgt = heights[start - 1]!;
    if (used > 0 && used + hgt > size) break;
    used += hgt;
    start -= 1;
    if (used >= size) break;
  }

  const visible = entries.slice(start, endExclusive);

  // Lines above the first visible entry / lines scrolled off the bottom.
  let hiddenAbove = 0;
  for (let i = 0; i < start; i += 1) hiddenAbove += heights[i]!;
  const hiddenBelow = clamped;

  return {
    visible,
    offset: clamped,
    maxOffset,
    hiddenAbove,
    hiddenBelow,
    viewport: size,
    totalLines,
  };
}

/**
 * Estimate how many terminal rows a transcript entry occupies (for line-based scroll).
 * Accounts for tool preview bodies and rough wrap width — not pixel-perfect, enough for maxOffset > 0
 * when a few tall tool rows fill the screen.
 */
export function estimateTranscriptEntryLines(
  entry: TranscriptEntry,
  columns = 80,
): number {
  const cols = Math.max(20, columns);
  if (entry.kind === "thinking") {
    if (entry.collapsed) return 1;
    return 1 + Math.max(1, wrappedLineCount(entry.text, cols - 2));
  }
  if (entry.kind === "tool") {
    const output = entry.output ?? "";
    const finished = entry.text === "done" || entry.text === "failed";
    const body = formatToolOutputBody(output, entry.previewCollapsed !== false, finished);
    const showExpand = entry.previewCollapsed === true && output.length > 0;
    // title row + body rows + optional expand hint
    let lines = 1;
    for (const row of body) {
      lines += wrappedLineCount(row, cols);
    }
    if (showExpand) lines += 1;
    return Math.max(1, lines);
  }
  if (entry.kind === "user" || entry.kind === "command") {
    // user bar + wrap + marginBottom ≈ content rows + 1
    return 1 + wrappedLineCount(entry.text, cols - 4);
  }
  if (entry.kind === "assistant") {
    return 1 + Math.max(1, wrappedLineCount(entry.text, cols - 2));
  }
  return Math.max(1, wrappedLineCount(entry.text || " ", cols - 2));
}

function wrappedLineCount(text: string, columns: number): number {
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

function useSessionInteraction(
  props: AppProps,
  setView: React.Dispatch<React.SetStateAction<ViewState>>,
  setScrollOffset: React.Dispatch<React.SetStateAction<number>>,
  appendScrollback: boolean,
  setScrollback: React.Dispatch<React.SetStateAction<ScrollbackState>>,
  scrollback: ScrollbackState,
  selectionApiRef: React.MutableRefObject<Readonly<{
    selectableLinesRef: React.MutableRefObject<string[]>;
    contentTopRowRef: React.MutableRefObject<number>;
    contentBottomRowRef: React.MutableRefObject<number>;
    textSelectionRef: React.MutableRefObject<TextSelectionRange | undefined>;
    dragActiveRef: React.MutableRefObject<boolean>;
    selectionFlashTimer: React.MutableRefObject<ReturnType<typeof setTimeout> | undefined>;
    lineTargetsRef: React.MutableRefObject<readonly LineTarget[]>;
    setTextSelection: React.Dispatch<React.SetStateAction<TextSelectionRange | undefined>>;
    clearTextSelection: () => void;
    finishTextSelectionCopy: (range: TextSelectionRange) => void;
  }>>,
  rows: number,
  scrollOffset: number,
): Readonly<{
  input: string;
  composer: ComposerState;
  busy: boolean;
  slashIndex: number;
  setSlashIndex: React.Dispatch<React.SetStateAction<number>>;
  atItems: readonly string[] | undefined;
  atIndex: number;
  transcriptViewer: HistoryBlock | undefined;
  viewerScrollOffset: number;
  setTranscriptViewer: React.Dispatch<React.SetStateAction<HistoryBlock | undefined>>;
  focusedSubagentId: number | undefined;
  setFocusedSubagentId: React.Dispatch<React.SetStateAction<number | undefined>>;
  /** Route B review overlay state (keyboard scroll over the Static transcript). */
  review: Readonly<{ offset: number }> | undefined;
  setReview: React.Dispatch<React.SetStateAction<Readonly<{ offset: number }> | undefined>>;
  search: SearchState | undefined;
  /** Command palette (Ctrl+P). */
  palette: Readonly<{ query: string; index: number }> | undefined;
  /** Esc layering: cancel turn / double-press clear draft. */
  pressEsc: () => boolean;
  escArmed: "clear-draft" | undefined;
  /** `?` shortcuts sheet. */
  shortcutsOpen: boolean;
  toggleShortcuts: () => void;
  shortcutsOffset: number;
  shortcutsScroll: (delta: number) => void;
  shortcutsClose: () => void;
  /** Manually folded block ids (tool/thinking/subagent collapse to title). */
  foldedBlockIds: ReadonlySet<number>;
  searchOpen: () => SearchState | undefined;
  openSearch: () => void;
  searchAppend: (chunk: string) => void;
  searchBackspace: () => void;
  searchNext: () => void;
  searchPrev: () => void;
  searchClose: () => void;
  copyReviewTop: () => void;
  copyViewer: () => void;
  topBlockOfCurrentView: () => HistoryBlock | undefined;
  toggleTopFold: () => void;
  viewTopBlock: () => void;
  paletteOpen: () => boolean;
  paletteInput: (chunk: string) => void;
  paletteBackspace: () => void;
  paletteMove: (delta: number) => void;
  paletteClose: () => void;
  paletteRun: () => void;
}> {
  const { exit } = useApp();
  const [composer, setComposer] = useState<ComposerState>(() =>
    props.initialDraft && props.initialDraft.length > 0
      ? setComposerText(emptyComposer(), props.initialDraft)
      : emptyComposer(),
  );
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const autoSubmitDone = useRef(false);
  const [transcriptViewer, setTranscriptViewerState] = useState<HistoryBlock | undefined>(undefined);
  const [viewerScrollOffset, setViewerScrollOffset] = useState(0);
  const setTranscriptViewer: React.Dispatch<React.SetStateAction<HistoryBlock | undefined>> = (action) => {
    setTranscriptViewerState((current) => {
      const next = typeof action === "function" ? action(current) : action;
      if (next?.id !== current?.id) setViewerScrollOffset(0);
      return next;
    });
  };
  const transcriptViewerRef = useRef(transcriptViewer);
  transcriptViewerRef.current = transcriptViewer;
  const [focusedSubagentId, setFocusedSubagentId] = useState<number | undefined>(undefined);
  const focusedSubagentIdRef = useRef(focusedSubagentId);
  focusedSubagentIdRef.current = focusedSubagentId;
  // Route B review overlay (keyboard scroll over the Static transcript) + search.
  const [review, setReview] = useState<Readonly<{ offset: number }> | undefined>(undefined);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const [search, setSearch] = useState<SearchState | undefined>(undefined);
  const searchRef = useRef(search);
  searchRef.current = search;
  // Manual folds (Grok h/l): compact blocks collapse to their title row.
  const [foldedBlockIds, setFoldedBlockIds] = useState<ReadonlySet<number>>(new Set());
  const foldedBlockIdsRef = useRef(foldedBlockIds);
  foldedBlockIdsRef.current = foldedBlockIds;
  // Command palette (Ctrl+P): searchable slash commands + built-in actions.
  const [palette, setPalette] = useState<Readonly<{ query: string; index: number }> | undefined>(undefined);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  // `?` shortcuts sheet (was advertised in the footer but never wired up).
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcutsOpenRef = useRef(shortcutsOpen);
  shortcutsOpenRef.current = shortcutsOpen;
  const [shortcutsOffset, setShortcutsOffset] = useState(0);
  // Esc layering (grok parity): busy → cancel (draft kept); idle non-empty
  // draft → double-press within 800ms clears it. A cancel suppresses the arm
  // for ~1s so mashing Esc to stop a turn can't wipe the draft.
  const [escArmed, setEscArmed] = useState<"clear-draft" | undefined>(undefined);
  const escArmedRef = useRef(escArmed);
  escArmedRef.current = escArmed;
  const lastCancelAtRef = useRef(0);
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pressEsc = (): boolean => {
    if (busyRef.current) {
      lastCancelAtRef.current = Date.now();
      setEscArmed(undefined);
      props.session.abortTurn();
      return true;
    }
    if (composerRef.current.text.length === 0) {
      setEscArmed(undefined);
      return false;
    }
    if (escArmedRef.current === "clear-draft") {
      setComposerState(setComposerText(composerRef.current, "", 0));
      setEscArmed(undefined);
      return true;
    }
    if (Date.now() - lastCancelAtRef.current < 1_000) {
      setEscArmed(undefined);
      return true;
    }
    setEscArmed("clear-draft");
    if (escTimerRef.current) clearTimeout(escTimerRef.current);
    escTimerRef.current = setTimeout(() => setEscArmed(undefined), 800);
    return true;
  };
  /** Last mouse press for double-click detection (same row within DOUBLE_CLICK_MS). */
  const lastPointerDownRef = useRef<{ at: number; row: number; col: number } | undefined>(undefined);
  const scrollbackRef = useRef(scrollback);
  scrollbackRef.current = scrollback;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashIndexRef = useRef(0);
  // `@` file picker: list loaded lazily on first trigger, Esc dismisses per query.
  const [fileList, setFileList] = useState<readonly string[] | undefined>(undefined);
  const fileListRef = useRef(fileList);
  fileListRef.current = fileList;
  const [atIndex, setAtIndex] = useState(0);
  const atIndexRef = useRef(0);
  const [atDismissed, setAtDismissed] = useState<string | undefined>(undefined);
  const atDismissedRef = useRef(atDismissed);
  atDismissedRef.current = atDismissed;
  const activeAtQuery = busy ? undefined : atQuery(composer.text, composer.cursor);
  const atItems = activeAtQuery !== undefined
    && atDismissed !== activeAtQuery
    && fileList !== undefined
    ? filterFiles(fileList, activeAtQuery, 50)
    : undefined;
  useEffect(() => {
    if (activeAtQuery === undefined || fileList !== undefined) return;
    let cancelled = false;
    // Same root the submit-time expansion resolves against (worktree-safe).
    void listWorkspaceFiles(props.session.workspacePerception.root).then((files) => {
      if (!cancelled) setFileList(files);
    });
    return () => {
      cancelled = true;
    };
  }, [activeAtQuery === undefined, fileList, props.session.workspacePerception.root]);
  const setComposerState = (next: ComposerState) => {
    const cleanedText = stripMouseLeak(next.text);
    const cleaned: ComposerState = cleanedText === next.text
      ? next
      : { ...next, text: cleanedText, cursor: Math.min(next.cursor, cleanedText.length) };
    composerRef.current = cleaned;
    setComposer(cleaned);
    setSlashIndex(0);
    slashIndexRef.current = 0;
    setAtIndex(0);
    atIndexRef.current = 0;
  };
  const setInputValue = (value: string) => {
    setComposerState(setComposerText(composerRef.current, stripMouseLeak(value)));
  };
  const moveSlash = (delta: number) => {
    setSlashIndex((current) => {
      const items = filterSlashCommands(
        collectSlashCommands(props.session.host),
        slashQuery(composerRef.current.text),
      );
      if (!items || items.length === 0) return 0;
      const next = (current + delta + items.length) % items.length;
      slashIndexRef.current = next;
      return next;
    });
  };
  const currentAtItems = (): readonly string[] | undefined => {
    if (busyRef.current || fileListRef.current === undefined) return undefined;
    const query = atQuery(composerRef.current.text, composerRef.current.cursor);
    if (query === undefined || atDismissedRef.current === query) return undefined;
    return filterFiles(fileListRef.current, query, 50);
  };
  const moveAt = (delta: number) => {
    setAtIndex((current) => {
      const items = currentAtItems();
      if (!items || items.length === 0) return 0;
      const next = (current + delta + items.length) % items.length;
      atIndexRef.current = next;
      return next;
    });
  };
  const insertAt = () => {
    const items = currentAtItems();
    if (!items || items.length === 0) return;
    const picked = items[Math.min(atIndexRef.current, items.length - 1)];
    if (picked) setComposerState(insertFileMention(composerRef.current, picked));
  };
  const dismissAt = () => {
    setAtDismissed(atQuery(composerRef.current.text, composerRef.current.cursor));
    setAtIndex(0);
    atIndexRef.current = 0;
  };
  const scrollViewer = (delta: number) => {
    setViewerScrollOffset((current) => {
      const block = transcriptViewerRef.current;
      if (!block) return 0;
      // Clamp to content: wheel/PgDn overshoot must not accrue invisible offset
      // debt that makes the next upward scroll feel dead (trackpad momentum).
      const { maxOffset } = viewerScrollBounds(block, process.stdout.rows ?? 24);
      return Math.max(0, Math.min(current + delta, maxOffset));
    });
  };
  const cycleViewer = (delta: -1 | 1) => {
    const current = transcriptViewerRef.current;
    if (!current) return;
    const next = adjacentExpandableHistoryBlock(scrollbackRef.current, current.id, delta);
    if (next && next.id !== current.id) setTranscriptViewer(next);
  };
  const scrollTranscript = (delta: number) => {
    if (appendScrollback) return; // terminal owns scroll
    setScrollOffset((current) => Math.max(0, current + delta));
  };
  const close = async (code: number) => {
    await props.onExit(code);
    exit(code);
  };
  const submit = async (rawValue = composerRef.current.text) => {
    const value = rawValue.trim();
    if (value.length === 0) return;
    // Busy turn: soft/hard steer at next tool/provider boundary (never mid-stream HTTP inject).
    // Prefix with ! for hard steer (abort + continue). Prefix with >> for follow-up
    // (runs only after natural end: no tools + soft empty). /exit still aborts and quits.
    if (busyRef.current) {
      if (value === "/exit" || value === "/quit") {
        props.session.abortTurn();
        await close(0);
        return;
      }
      const intent = parseBusySubmitIntent(value);
      if (!intent) return;
      if (intent.kind === "follow_up" && typeof props.session.followUp === "function") {
        props.session.followUp(intent.text);
        setComposerState(rememberSubmission(composerRef.current, value));
        const notice = `Follow-up queued (after current task ends): ${intent.text.slice(0, 80)}`;
        setScrollback((current) => reduceScrollback(current, { kind: "notice", text: notice }));
        setView((current) => reduceEvent(current, {
          kind: "status",
          key: "queue",
          text: "follow-up",
        }));
        return;
      }
      if (typeof props.session.steer === "function" && (intent.kind === "soft" || intent.kind === "hard")) {
        props.session.steer(intent.text, intent.kind);
        setComposerState(rememberSubmission(composerRef.current, value));
        const notice = intent.kind === "hard"
          ? `Hard steer: ${intent.text.slice(0, 80)}`
          : `Soft steer queued (applies at tool/provider boundary): ${intent.text.slice(0, 80)}`;
        setScrollback((current) => reduceScrollback(current, { kind: "notice", text: notice }));
        setView((current) => reduceEvent(current, {
          kind: "status",
          key: "queue",
          text: intent.kind === "hard" ? "hard-steer" : "soft-steer",
        }));
        return;
      }
      // Fallback if session lacks steer (older bridges).
      setComposerState(queueWhileBusy(composerRef.current, value));
      const notice = `Queued for next turn: ${value.slice(0, 80)}`;
      setScrollback((current) => reduceScrollback(current, { kind: "notice", text: notice }));
      setView((current) => reduceEvent(current, {
        kind: "status",
        key: "queue",
        text: "queued",
      }));
      return;
    }
    setComposerState(rememberSubmission(composerRef.current, value));
    setScrollOffset(0);
    const isCommand = value.startsWith("/");
    setScrollback((current) => appendUserBlock(current, value));
    if (value === "/exit" || value === "/quit") {
      await close(0);
      return;
    }
    const startedAt = Date.now();
    const isPrompt = !isCommand;
    busyRef.current = true;
    setBusy(true);
    try {
      await runInput(props.session, value, props.bridge);
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (isPrompt) {
        const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        const done = `* Done in ${seconds}s`;
        setScrollback((current) => reduceScrollback(current, { kind: "notice", text: done }));
      }
      // Restore queued input into the draft so it can be inspected/edited/submitted.
      const queued = composerRef.current.queue;
      if (queued) {
        setComposerState(loadQueueIntoDraft(composerRef.current));
        setView((current) => reduceEvent(current, { kind: "status", key: "queue", text: undefined }));
      }
    }
  };
  // Fullscreen: mouse wheel scrolls; press-drag selects + copies on release (Grok-style).
  // Bare click does not copy; move ≥1 cell then release to copy. Double-click on a
  // subagent/tool/thinking row drills into its transcript (running workers open live).
  const openTargetAtRow = (row: number): boolean => {
    const api = selectionApiRef.current;
    const index = row - api.contentTopRowRef.current;
    const targets = api.lineTargetsRef.current;
    if (index < 0 || index >= targets.length) return false;
    const target = targets[index]!;
    if (target.type === "block") {
      const block = scrollbackRef.current.blocks.find((candidate) => candidate.id === target.blockId);
      if (block && (block.output?.length ?? 0) > 0) {
        setTranscriptViewer(block);
        return true;
      }
      return false;
    }
    if (target.type === "subagent") {
      setFocusedSubagentId(target.workerId);
      return true;
    }
    return false;
  };
  useEffect(() => {
    if (appendScrollback) return;
    return attachMouseScrollListener(process.stdin, {
      onScroll: (direction) => {
        if (focusedSubagentIdRef.current !== undefined) return; // live overlay auto-follows
        if (transcriptViewerRef.current) {
          scrollViewer(direction === "up" ? -1 : 1);
          return;
        }
        // One line per notch (grok parity); burst notches coalesce into a
        // single frame by Ink's render throttle.
        scrollTranscript(direction === "up" ? 1 : -1);
      },
      onPointer: (kind, col, row) => {
        if (transcriptViewerRef.current || focusedSubagentIdRef.current !== undefined) return;
        const api = selectionApiRef.current;
        const lines = api.selectableLinesRef.current;
        const hit = {
          col,
          row,
          contentTopRow: api.contentTopRowRef.current,
          contentBottomRow: api.contentBottomRowRef.current,
          lines,
          clampToBand: true as const,
        };
        const cell = cellFromMouse(hit);
        if (kind === "down") {
          const previous = lastPointerDownRef.current;
          const now = Date.now();
          lastPointerDownRef.current = { at: now, row, col };
          if (
            previous
            && now - previous.at <= DOUBLE_CLICK_MS
            && previous.row === row
            && Math.abs(previous.col - col) <= 2
          ) {
            lastPointerDownRef.current = undefined;
            if (openTargetAtRow(row)) {
              api.clearTextSelection();
              return;
            }
          }
          if (!cell) {
            api.clearTextSelection();
            return;
          }
          if (api.selectionFlashTimer.current) {
            clearTimeout(api.selectionFlashTimer.current);
            api.selectionFlashTimer.current = undefined;
          }
          api.dragActiveRef.current = true;
          api.setTextSelection({ anchor: cell, head: cell });
          return;
        }
        if (kind === "drag") {
          if (!api.dragActiveRef.current || !cell) return;
          api.setTextSelection((current) =>
            current ? { anchor: current.anchor, head: cell } : { anchor: cell, head: cell });
          return;
        }
        // up — copy only when the pointer moved at least one cell (Grok threshold).
        if (!api.dragActiveRef.current) return;
        const current = api.textSelectionRef.current;
        if (!current) {
          api.dragActiveRef.current = false;
          return;
        }
        const finalRange = cell
          ? { anchor: current.anchor, head: cell }
          : current;
        api.dragActiveRef.current = false;
        if (selectionDragDistance(finalRange) < 1) {
          // Bare click: no selection — open the block under the pointer
          // (grok selects the entry; this TUI has no scrollback cursor, so a
          // click drills straight into the retained output).
          api.clearTextSelection();
          if (!openTargetAtRow(row)) {
            api.clearTextSelection();
          }
          return;
        }
        api.finishTextSelectionCopy(finalRange);
      },
    });
  }, [appendScrollback, selectionApiRef]);
  // Drain from interactive boot shell: optional auto-submit after first paint.
  useEffect(() => {
    if (autoSubmitDone.current) return;
    if (props.autoSubmitInitial !== true) return;
    const draft = composerRef.current.text.trim();
    if (draft.length === 0) return;
    autoSubmitDone.current = true;
    void submit(draft);
  }, [props.autoSubmitInitial]);
  useInput((character, key) => handleInput({
    character,
    key,
    composer: composerRef.current,
    busy: busyRef.current,
    interaction: interactionMode(props.bridge),
    slashIndex: slashIndexRef.current,
    slashItems: filterSlashCommands(
      collectSlashCommands(props.session.host),
      slashQuery(composerRef.current.text),
    ),
    atItems: currentAtItems(),
    atIndex: atIndexRef.current,
    moveAt,
    insertAt,
    dismissAt,
    setInputValue,
    setComposerState,
    moveSlash,
    submit,
    close,
    session: props.session,
    bridge: props.bridge,
    scrollConfirm: (delta) => setView((current) => scrollConfirmation(current, delta)),
    scrollTranscript,
    scrollViewer,
    cycleViewer,
    viewerOpen: () => transcriptViewerRef.current !== undefined,
    appendScrollback,
    rows,
    searchOpen: () => searchRef.current,
    openSearch: () => setSearch({ query: "", index: 0, results: [] }),
    searchAppend: (chunk: string) => applySearchQuery(`${searchRef.current?.query ?? ""}${chunk}`),
    searchBackspace: () => applySearchQuery((searchRef.current?.query ?? "").slice(0, -1)),
    searchNext: () => searchStep(1),
    searchPrev: () => searchStep(-1),
    searchClose: () => setSearch(undefined),
    reviewOpen: () => reviewRef.current !== undefined,
    reviewScroll: (delta) => setReview((current) => ({
      ...(current ?? { offset: 0 }),
      offset: Math.max(0, (current?.offset ?? 0) + delta),
    })),
    copyReviewTop,
    copyViewer: () => copyBlock(transcriptViewerRef.current),
    topBlockOfCurrentView,
    toggleTopFold,
    viewTopBlock,
    paletteOpen: () => paletteRef.current !== undefined,
    paletteInput: (chunk: string) => setPalette((current) => {
      const query = `${current?.query ?? ""}${chunk}`;
      return { query, index: 0 };
    }),
    paletteBackspace: () => setPalette((current) => {
      const query = (current?.query ?? "").slice(0, -1);
      return { query, index: 0 };
    }),
    paletteMove: (delta: number) => setPalette((current) => {
      if (!current) return current;
      const count = filteredPalette(current.query).length;
      if (count === 0) return current;
      return { ...current, index: (current.index + delta + count) % count };
    }),
    paletteClose: () => setPalette(undefined),
    paletteRun,
    pressEsc,
    escArmed,
    shortcutsOpen: () => shortcutsOpen,
    toggleShortcuts: () => {
      setShortcutsOpen((open) => {
        if (!open) setShortcutsOffset(0);
        return !open;
      });
    },
    shortcutsScroll: (delta: number) =>
      setShortcutsOffset((current) => Math.max(0, current + delta)),
    shortcutsClose: () => setShortcutsOpen(false),
    moveSelect: (delta) => setView((current) => moveSelection(current, delta)),
    setPromptValue: (value) => setView((current) => setPromptDraft(current, value)),
    toggleExpandable: () => {
      // Ctrl+O: overlay over retained thinking/tool/subagent output.
      if (focusedSubagentIdRef.current !== undefined) {
        setFocusedSubagentId(undefined);
        return;
      }
      if (transcriptViewerRef.current) {
        setTranscriptViewer(undefined);
        return;
      }
      const current = scrollbackRef.current;
      const block = latestExpandableToolBlock(current);
      if (block?.output) setTranscriptViewer(block);
    },
    closeSubagentOverlay: () => {
      if (focusedSubagentIdRef.current === undefined) return false;
      setFocusedSubagentId(undefined);
      return true;
    },
    subagentOverlayOpen: () => focusedSubagentIdRef.current !== undefined,
    closeTranscriptViewer: () => {
      if (!transcriptViewerRef.current) return false;
      setTranscriptViewer(undefined);
      return true;
    },
    clearTextSelection: () => {
      const api = selectionApiRef.current;
      if (!api.textSelectionRef.current && !api.dragActiveRef.current) return false;
      api.clearTextSelection();
      return true;
    },
    clearQueued: () => {
      setComposerState(clearQueue(composerRef.current));
      setView((current) => reduceEvent(current, { kind: "status", key: "queue", text: undefined }));
    },
  }));

  // --- Search + route B review overlay ---
  const jumpToSearchLine = (lineIndex: number) => {
    const total = transcriptFlatLines(scrollbackRef.current.blocks).length;
    const offset = scrollOffsetForLine(total, lineIndex);
    if (appendScrollback) {
      setReview({ offset });
    } else {
      setScrollOffset(offset);
    }
  };
  const applySearchQuery = (query: string) => {
    const results = searchTranscriptLines(scrollbackRef.current.blocks, query);
    setSearch({ query, index: 0, results });
    if (results.length > 0) jumpToSearchLine(results[0]!);
  };
  const searchStep = (direction: 1 | -1) => {
    const current = searchRef.current;
    if (!current || current.results.length === 0) return;
    const count = current.results.length;
    const index = ((current.index + direction) % count + count) % count;
    jumpToSearchLine(current.results[index]!);
    setSearch({ ...current, index });
  };
  const copyBlock = (block: HistoryBlock | undefined) => {
    if (!block) return;
    const text = blockFullText(block);
    if (text.trim().length === 0) return;
    const result = copyTextToClipboard(text);
    setScrollback((current) => reduceScrollback(current, {
      kind: "notice",
      level: result.ok ? undefined : "error",
      text: result.ok
        ? `Copied to clipboard (${result.via.join(", ")})`
        : "Copy failed: no clipboard available",
    }));
  };
  const copyReviewTop = () => {
    // The window's top row owns the copy; viewport is measured in the overlay,
    // so find the block by the line the current offset exposes (viewport 1).
    const blocks = scrollbackRef.current.blocks;
    const total = transcriptFlatLines(blocks).length;
    const offset = reviewRef.current?.offset ?? 0;
    const topIndex = Math.max(0, total - 1 - offset);
    let cursor = 0;
    for (const block of blocks) {
      const count = Math.max(1, block.lines.length);
      if (topIndex < cursor + count) {
        copyBlock(block);
        return;
      }
      cursor += count;
    }
  };
  // Block at the top of the current view (fullscreen window or review overlay).
  const topBlockOfCurrentView = (): HistoryBlock | undefined => {
    const blocks = scrollbackRef.current.blocks;
    const total = transcriptFlatLines(blocks).length;
    const offset = appendScrollback
      ? (reviewRef.current?.offset ?? 0)
      : scrollOffset;
    const topIndex = Math.max(0, total - 1 - offset);
    let cursor = 0;
    for (const block of blocks) {
      const count = Math.max(1, block.lines.length);
      if (topIndex < cursor + count) return block;
      cursor += count;
    }
    return undefined;
  };
  const toggleTopFold = () => {
    const block = topBlockOfCurrentView();
    if (!block) return;
    const compact = block.kind === "tool" || block.kind === "thinking" || block.kind === "subagent";
    if (!compact) return;
    setFoldedBlockIds((current) => {
      const next = new Set(current);
      if (next.has(block.id)) next.delete(block.id);
      else next.add(block.id);
      return next;
    });
  };
  const viewTopBlock = () => {
    const block = topBlockOfCurrentView();
    if (block && (block.output?.length ?? 0) > 0) setTranscriptViewer(block);
  };
  const paletteEntries = () => {
    const commands = collectSlashCommands(props.session.host);
    return commands.map((command) => ({ label: `/${command.name}`, description: command.description }));
  };
  const filteredPalette = (query: string) =>
    fuzzyFilter(paletteEntries(), query, (entry) => entry.label);
  const paletteRun = () => {
    const current = paletteRef.current;
    if (!current) return;
    const filtered = filteredPalette(current.query);
    const picked = filtered[Math.min(current.index, filtered.length - 1)];
    setPalette(undefined);
    if (picked) void submit(`/${picked.label.slice(1).split(/\s+/)[0]}`);
  };
  const inputDisplay = composer.queue
    ? `${composer.text}${composer.text ? " " : ""}[queued: ${composer.queue.slice(0, 40)}${composer.queue.length > 40 ? "…" : ""}]`
    : composer.text;
  return {
    input: inputDisplay,
    composer,
    busy,
    slashIndex,
    setSlashIndex,
    atItems,
    atIndex,
    transcriptViewer,
    viewerScrollOffset,
    setTranscriptViewer,
    focusedSubagentId,
    setFocusedSubagentId,
    review,
    setReview,
    search,
    palette,
    foldedBlockIds,
    searchOpen: () => searchRef.current,
    openSearch: () => setSearch({ query: "", index: 0, results: [] }),
    searchAppend: (chunk: string) => applySearchQuery(`${searchRef.current?.query ?? ""}${chunk}`),
    searchBackspace: () => applySearchQuery((searchRef.current?.query ?? "").slice(0, -1)),
    searchNext: () => searchStep(1),
    searchPrev: () => searchStep(-1),
    searchClose: () => setSearch(undefined),
    copyReviewTop,
    copyViewer: () => copyBlock(transcriptViewerRef.current),
    topBlockOfCurrentView,
    toggleTopFold,
    viewTopBlock,
    paletteOpen: () => paletteRef.current !== undefined,
    paletteInput: (chunk: string) => setPalette((current) => {
      const query = `${current?.query ?? ""}${chunk}`;
      return { query, index: 0 };
    }),
    paletteBackspace: () => setPalette((current) => {
      const query = (current?.query ?? "").slice(0, -1);
      return { query, index: 0 };
    }),
    paletteMove: (delta: number) => setPalette((current) => {
      if (!current) return current;
      const count = filteredPalette(current.query).length;
      if (count === 0) return current;
      return { ...current, index: (current.index + delta + count) % count };
    }),
    paletteClose: () => setPalette(undefined),
    paletteRun,
    pressEsc,
    escArmed,
    shortcutsOpen,
    shortcutsOffset,
    toggleShortcuts: () => {
      setShortcutsOpen((open) => {
        if (!open) setShortcutsOffset(0);
        return !open;
      });
    },
    shortcutsScroll: (delta: number) =>
      setShortcutsOffset((current) => Math.max(0, current + delta)),
    shortcutsClose: () => setShortcutsOpen(false),
  };
}

function interactionMode(bridge: TuiSessionBridge): "confirm" | "select" | "prompt" | "none" {
  if (bridge.confirmPending) return "confirm";
  if (bridge.selectPending) return "select";
  if (bridge.promptPending) return "prompt";
  return "none";
}

function handleInput(options: Readonly<{
  character: string;
  key: Readonly<{
    ctrl: boolean;
    meta: boolean;
    shift?: boolean;
    return: boolean;
    backspace: boolean;
    delete: boolean;
    escape?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    pageUp?: boolean;
    pageDown?: boolean;
    home?: boolean;
    end?: boolean;
    tab?: boolean;
  }>;
  composer: ComposerState;
  busy: boolean;
  setInputValue: (value: string) => void;
  setComposerState: (state: ComposerState) => void;
  moveSlash: (delta: number) => void;
  submit: (value?: string) => Promise<void>;
  close: (code: number) => Promise<void>;
  session: PreparedSession;
  bridge: TuiSessionBridge;
  interaction: "confirm" | "select" | "prompt" | "none";
  slashIndex: number;
  slashItems: readonly SlashCommand[] | undefined;
  atItems: readonly string[] | undefined;
  atIndex: number;
  moveAt: (delta: number) => void;
  insertAt: () => void;
  dismissAt: () => void;
  scrollConfirm: (delta: number) => void;
  scrollTranscript: (delta: number) => void;
  scrollViewer?: (delta: number) => void;
  cycleViewer?: (delta: -1 | 1) => void;
  viewerOpen?: () => boolean;
  appendScrollback?: boolean;
  moveSelect: (delta: number) => void;
  setPromptValue: (value: string) => void;
  toggleExpandable: () => void;
  /** Returns true when an open transcript overlay was closed. */
  closeTranscriptViewer?: () => boolean;
  /** Returns true when the live subagent overlay was closed. */
  closeSubagentOverlay?: () => boolean;
  /** True while the live subagent overlay is open (consumes nav keys). */
  subagentOverlayOpen?: () => boolean;
  /** Returns true when an in-app text selection was cleared. */
  clearTextSelection?: () => boolean;
  clearQueued: () => void;
  /** Terminal height for page-sized scroll steps (Ctrl+U/D). */
  rows: number;
  /** Active transcript search, if any. */
  searchOpen?: () => SearchState | undefined;
  openSearch?: () => void;
  searchAppend?: (chunk: string) => void;
  searchBackspace?: () => void;
  searchNext?: () => void;
  searchPrev?: () => void;
  searchClose?: () => void;
  /** Route B review overlay is open (consumes scroll keys + `y`). */
  reviewOpen?: () => boolean;
  reviewScroll?: (delta: number) => void;
  copyReviewTop?: () => void;
  copyViewer?: () => void;
  /** Block at the top of the current view (fold / view targets). */
  topBlockOfCurrentView?: () => HistoryBlock | undefined;
  toggleTopFold?: () => void;
  viewTopBlock?: () => void;
  /** Esc layering: cancel turn / double-press clear draft. Returns handled. */
  pressEsc: () => boolean;
  /** Esc arm state for the composer hint. */
  escArmed: "clear-draft" | undefined;
  /** `?` shortcuts sheet. */
  shortcutsOpen?: () => boolean;
  shortcutsScroll?: (delta: number) => void;
  shortcutsClose?: () => void;
  toggleShortcuts?: () => void;
  /** Command palette (Ctrl+P). */
  paletteOpen?: () => boolean;
  paletteInput?: (chunk: string) => void;
  paletteBackspace?: () => void;
  paletteMove?: (delta: number) => void;
  paletteClose?: () => void;
  paletteRun?: () => void;
}>): void {
  if (options.interaction === "confirm") {
    handleConfirmInput(options);
    return;
  }
  if (options.interaction === "select") {
    handleSelectInput(options);
    return;
  }
  if (options.interaction === "prompt") {
    handlePromptInput(options);
    return;
  }
  if (options.key.ctrl && options.character === "c") {
    if (options.busy) options.session.abortTurn();
    else void options.close(0);
    return;
  }
  // `?` shortcuts sheet: while open it owns navigation; Esc closes, and the
  // sheet itself was advertised by the footer but never wired up before.
  if (options.shortcutsOpen?.()) {
    if (options.key.escape) {
      options.shortcutsClose?.();
      return;
    }
    if (options.key.upArrow || options.key.pageUp) {
      options.shortcutsScroll?.(1);
      return;
    }
    if (options.key.downArrow || options.key.pageDown) {
      options.shortcutsScroll?.(-1);
      return;
    }
    return;
  }
  // Command palette (Ctrl+P): while open it owns typing, navigation and Enter.
  if (options.paletteOpen?.()) {
    if (options.key.escape) {
      options.paletteClose?.();
      return;
    }
    if (options.key.return) {
      options.paletteRun?.();
      return;
    }
    if (options.key.upArrow) {
      options.paletteMove?.(-1);
      return;
    }
    if (options.key.downArrow) {
      options.paletteMove?.(1);
      return;
    }
    if (options.key.backspace && !options.key.meta) {
      options.paletteBackspace?.();
      return;
    }
    if (!options.key.ctrl && !options.key.meta && options.character.length > 0) {
      options.paletteInput?.(options.character);
      return;
    }
    return;
  }
  // Search-in-transcript: while open it swallows typing (query input) and
  // navigation keys; Esc closes search first, then the review overlay.
  const searchState = options.searchOpen?.();
  if (searchState) {
    if (options.key.escape) {
      options.searchClose?.();
      return;
    }
    if (options.key.return || options.key.downArrow) {
      options.searchNext?.();
      return;
    }
    if (options.key.upArrow) {
      options.searchPrev?.();
      return;
    }
    if (options.key.ctrl && options.character === "f") {
      options.searchClose?.();
      return;
    }
    if (options.key.backspace && !options.key.meta) {
      options.searchBackspace?.();
      return;
    }
    if (!options.key.ctrl && !options.key.meta && options.character.length > 0) {
      options.searchAppend?.(options.character);
      return;
    }
    return;
  }
  // Ctrl+F toggles search; `y` copies while the review overlay or the Ctrl+O
  // transcript viewer is open (never a bare keystroke otherwise).
  if (options.key.ctrl && options.character === "f") {
    options.openSearch?.();
    return;
  }
  // Ctrl+P command palette, Ctrl+T model switch (Ctrl+M is Return on most
  // terminals without the Kitty keyboard protocol, so grok's binding is not
  // reachable here).
  if (options.key.ctrl && options.character === "p") {
    options.paletteOpen?.() ? options.paletteClose?.() : options.paletteInput?.("");
    return;
  }
  if (options.character === "?" && !options.key.ctrl && !options.key.meta) {
    options.toggleShortcuts?.();
    return;
  }
  if (options.key.ctrl && options.character === "t" && !options.busy) {
    void options.submit("/model");
    return;
  }
  // Fold / unfold the block at the top of the current view (Ctrl+R — grok's
  // h/l need a scrollback focus that this TUI does not have).
  if (options.key.ctrl && options.character === "r") {
    options.toggleTopFold?.();
    return;
  }
  if (options.character === "y" && !options.key.ctrl && !options.key.meta) {
    if (options.reviewOpen?.()) {
      options.copyReviewTop?.();
      return;
    }
    if (options.viewerOpen?.()) {
      options.copyViewer?.();
      return;
    }
  }
  if (options.key.ctrl && options.character === "o") {
    options.toggleExpandable();
    return;
  }
  if (options.key.escape && options.closeSubagentOverlay?.()) {
    return;
  }
  if (options.key.escape && options.closeTranscriptViewer?.()) {
    return;
  }
  if (options.key.escape && options.clearTextSelection?.()) {
    return;
  }
  // Esc layering after overlays: busy → cancel (draft kept); idle non-empty
  // draft → double-press clears it (see pressEsc in the interaction hook).
  if (options.key.escape && options.pressEsc?.()) {
    return;
  }

  // Live subagent overlay: auto-follows; swallow nav keys so the transcript
  // window behind it does not scroll.
  if (options.subagentOverlayOpen?.()
    && (options.key.upArrow || options.key.downArrow || options.key.pageUp || options.key.pageDown)) {
    return;
  }

  // Transcript viewer: scroll full retained output in-overlay.
  if (options.viewerOpen?.()) {
    const step = options.key.pageUp || options.key.pageDown ? 12 : 1;
    if (options.key.leftArrow) {
      options.cycleViewer?.(-1);
      return;
    }
    if (options.key.rightArrow) {
      options.cycleViewer?.(1);
      return;
    }
    if (options.key.pageUp || options.key.upArrow) {
      options.scrollViewer?.(-step);
      return;
    }
    if (options.key.pageDown || options.key.downArrow) {
      options.scrollViewer?.(step);
      return;
    }
    if (options.key.ctrl && options.character === "g") {
      options.scrollViewer?.(-100_000);
      return;
    }
    if (options.key.ctrl && options.character === "e") {
      options.scrollViewer?.(100_000);
      return;
    }
  }

  // Ctrl+X drops the busy-turn queue without submitting.
  if (options.key.ctrl && options.character === "x" && options.composer.queue) {
    options.clearQueued();
    return;
  }

  // Shift+Tab: permission mode (auto → full → strict), even while slash menu is open.
  if (options.key.tab && options.key.shift && !options.busy) {
    options.session.cyclePermissionMode();
    return;
  }

  const slashOpen = !options.busy && options.slashItems !== undefined;
  if (slashOpen && options.slashItems && options.slashItems.length > 0) {
    if (options.key.upArrow) {
      options.moveSlash(-1);
      return;
    }
    if (options.key.downArrow) {
      options.moveSlash(1);
      return;
    }
    if (options.key.tab) {
      const picked = options.slashItems[Math.min(options.slashIndex, options.slashItems.length - 1)];
      if (picked) options.setInputValue(`/${picked.name}`);
      return;
    }
    if (options.key.return) {
      const picked = options.slashItems[Math.min(options.slashIndex, options.slashItems.length - 1)];
      void options.submit(picked ? `/${picked.name}` : options.composer.text);
      return;
    }
  }

  // `@` file picker: navigation/insert/dismiss take priority over history and submit.
  if (!slashOpen && !options.busy && options.atItems !== undefined) {
    if (options.key.escape) {
      options.dismissAt();
      return;
    }
    if (options.atItems.length > 0) {
      if (options.key.upArrow) {
        options.moveAt(-1);
        return;
      }
      if (options.key.downArrow) {
        options.moveAt(1);
        return;
      }
      if (options.key.tab || options.key.return) {
        options.insertAt();
        return;
      }
    }
  }

  // Route B: the terminal owns the Static scrollback, so PgUp/PgDn and the
  // Grok line/half-page chords open the in-app review overlay (first press
  // scrolls it too). Fullscreen already binds the same keys to its window.
  if (options.appendScrollback) {
    const halfPage = Math.max(4, Math.floor(options.rows / 2));
    let step = 0;
    if (options.key.pageUp) step = 20;
    else if (options.key.pageDown) step = -20;
    else if (options.key.ctrl && options.character === "j") step = 1;
    else if (options.key.ctrl && options.character === "k") step = -1;
    else if (options.key.ctrl && options.character === "u" && options.composer.text.length === 0) step = halfPage;
    else if (options.key.ctrl && options.character === "d") step = -halfPage;
    if (step !== 0) {
      options.reviewScroll?.(step);
      return;
    }
  }

  // Route A only: self-managed transcript scroll. Route B: composer history + cursor.
  if (!options.appendScrollback) {
    const halfPage = Math.max(4, Math.floor(options.rows / 2));
    if (options.key.pageUp) {
      options.scrollTranscript(20);
      return;
    }
    if (options.key.pageDown) {
      options.scrollTranscript(-20);
      return;
    }
    if (options.key.upArrow) {
      options.scrollTranscript(3);
      return;
    }
    if (options.key.downArrow) {
      options.scrollTranscript(-3);
      return;
    }
    if (options.key.ctrl && options.character === "g") {
      options.scrollTranscript(100_000);
      return;
    }
    if (options.key.ctrl && options.character === "e") {
      options.scrollTranscript(-100_000);
      return;
    }
    // Grok parity: Ctrl+J/K line scroll, Ctrl+U/D half-page (Ctrl+U only when
    // the draft is empty — with text it is the readline kill-to-cursor below).
    if (options.key.ctrl && options.character === "j") {
      options.scrollTranscript(1);
      return;
    }
    if (options.key.ctrl && options.character === "k") {
      options.scrollTranscript(-1);
      return;
    }
    if (options.key.ctrl && options.character === "u" && options.composer.text.length === 0) {
      options.scrollTranscript(halfPage);
      return;
    }
    if (options.key.ctrl && options.character === "d") {
      options.scrollTranscript(-halfPage);
      return;
    }
  } else {
    const multilineDraft = options.composer.text.includes("\n");
    if (options.key.upArrow && multilineDraft) {
      options.setComposerState(moveCursorLine(options.composer, -1));
      return;
    }
    if (options.key.downArrow && multilineDraft) {
      options.setComposerState(moveCursorLine(options.composer, 1));
      return;
    }
    // Route B: up/down walk prompt history when draft is single-line idle.
    if (options.key.upArrow && !options.busy) {
      options.setComposerState(historyUp(options.composer));
      return;
    }
    if (options.key.downArrow && !options.busy) {
      options.setComposerState(historyDown(options.composer));
      return;
    }
  }

  if (options.key.leftArrow) {
    if (options.key.ctrl || options.key.meta) {
      options.setComposerState(moveCursorWord(options.composer, -1));
    } else {
      options.setComposerState(moveCursor(options.composer, -1));
    }
    return;
  }
  if (options.key.rightArrow) {
    if (options.key.ctrl || options.key.meta) {
      options.setComposerState(moveCursorWord(options.composer, 1));
    } else {
      options.setComposerState(moveCursor(options.composer, 1));
    }
    return;
  }

  // Line start/end (Home/End, Ctrl+A/E — readline/Emacs).
  if (options.key.home || (options.key.ctrl && options.character === "a")) {
    options.setComposerState(moveCursorTo(options.composer, 0));
    return;
  }
  if (options.key.end || (options.key.ctrl && options.character === "e")) {
    options.setComposerState(moveCursorTo(options.composer, options.composer.text.length));
    return;
  }
  // Word moves / kills (Emacs alt bindings, macOS Option+arrows).
  if (options.key.meta && options.character === "b") {
    options.setComposerState(moveCursorWord(options.composer, -1));
    return;
  }
  if (options.key.meta && options.character === "f") {
    options.setComposerState(moveCursorWord(options.composer, 1));
    return;
  }
  if (options.key.meta && options.character === "d") {
    options.setComposerState(deleteWordForward(options.composer));
    return;
  }
  if (options.key.meta && options.key.backspace) {
    options.setComposerState(deleteWordBackward(options.composer));
    return;
  }

  if (options.key.tab && !options.busy) {
    void options.session.cycleThinkingLevel();
    return;
  }
  // Multi-char chunks (paste / whole-line entry) and embedded newlines.
  if (options.character.length > 1 || (options.character.search(/[\r\n]/) >= 0 && !options.key.return)) {
    if (isMouseLeakChunk(options.character)) return;
    const applied = applyInputChunk(options.composer, options.character, {
      return: options.key.return,
      shift: options.key.shift,
    });
    options.setComposerState(applied.state);
    if (applied.submit) void options.submit(applied.state.text);
    return;
  }
  if (options.key.return) {
    const applied = applyInputChunk(options.composer, "", {
      return: true,
      shift: options.key.shift,
    });
    if (applied.submit) void options.submit(applied.state.text);
    else options.setComposerState(applied.state);
    return;
  }
  if (options.key.delete && !options.key.backspace) {
    options.setComposerState(deleteForward(options.composer));
    return;
  }
  if (options.key.backspace) {
    options.setComposerState(deleteBackward(options.composer));
    return;
  }
  // Ctrl+U: readline kill-to-cursor. With an empty draft it scrolls a half page
  // up in fullscreen (handled above); here it always has text to kill.
  if (options.key.ctrl && options.character === "u") {
    options.setComposerState(killToCursor(options.composer));
    return;
  }
  // Ignore pure mouse-SGR chunks (trackpad/wheel) so they never append to the prompt.
  if (isMouseLeakChunk(options.character)) {
    return;
  }
  if (!options.key.ctrl && !options.key.meta && options.character.length > 0) {
    const applied = applyInputChunk(options.composer, options.character, options.key);
    if (applied.submit) void options.submit(applied.state.text);
    else options.setComposerState(applied.state);
  }
}

async function runInput(session: PreparedSession, value: string, bridge: TuiSessionBridge): Promise<void> {
  try {
    if (value === "/help") {
      const names = collectSlashCommands(session.host).map((command) => `/${command.name}`).join(" ");
      bridge.sink.notify?.(
        `Commands: ${names} · Shift+Tab permissions · Tab thinking · Ctrl+O transcript · ? /help`,
        "info",
      );
      return;
    }
    if (value.startsWith("/")) {
      const [name, ...args] = value.slice(1).split(/\s+/);
      if (!name) return;
      // /bypass is registered as a permission-full alias on the host when
      // prepareSession ran; fall back for test stubs without that command.
      if (name === "bypass" && !session.host.getCommand("bypass")) {
        const arg = args.join(" ").trim().toLowerCase();
        const next = arg === "off" ? "auto" : "full";
        session.setPermissionMode(next);
        bridge.sink.notify?.(
          next === "full"
            ? "权限模式: 完全 (full) — unsafe/complex shell and merge/rollback still confirm. Restore: /permission auto"
            : "权限模式: 自动 (auto)",
          next === "full" ? "warning" : "info",
        );
        return;
      }
      const result = await session.host.runCommand(name, args.join(" "));
      if (result !== undefined) bridge.sink.notify?.(formatResult(result), "info");
      return;
    }
    // `@path` mentions expand into bounded file blocks in the outgoing prompt only
    // (transcript keeps the raw typed text; steer path stays raw as well).
    await session.runPrompt(await expandFileMentions(value, session.workspacePerception.root));
  } catch (error) {
    if (!isContextCompactionError(error)) {
      bridge.sink.notify?.(error instanceof Error ? error.message : String(error), "error");
    }
  }
}

/** Exported for unit tests of transcript reduce semantics. */
export function reduceEvent(state: ViewState, event: TuiEvent): ViewState {
  if (event.kind === "confirm-open") {
    return { ...state, confirm: { question: event.question, detail: event.detail ?? "", scroll: 0 }, select: undefined, prompt: undefined };
  }
  if (event.kind === "confirm-close") return { ...state, confirm: undefined };
  if (event.kind === "select-open") {
    selectedValueHolder = event.choices[0]?.value;
    promptDraftHolder = "";
    return {
      ...state,
      select: { question: event.question, choices: event.choices, selected: 0 },
      confirm: undefined,
      prompt: undefined,
    };
  }
  if (event.kind === "select-close") return { ...state, select: undefined };
  if (event.kind === "prompt-open") {
    promptDraftHolder = "";
    return {
      ...state,
      prompt: { question: event.question, secret: event.secret === true, value: "" },
      confirm: undefined,
      select: undefined,
    };
  }
  if (event.kind === "prompt-close") return { ...state, prompt: undefined };
  if (event.kind === "context-compaction") return reduceContextCompaction(state, event.event);
  if (event.kind === "status") {
    const statuses = { ...state.statuses };
    if (event.text) statuses[event.key] = event.text;
    else delete statuses[event.key];
    return { ...state, statuses };
  }
  if (event.kind === "widget") {
    if (event.key === "tasklist") {
      const widgets = { ...state.widgets };
      if (event.lines && event.lines.length > 0) widgets.tasklist = event.lines;
      else delete widgets.tasklist;
      return { ...state, widgets };
    }
    return event.lines ? appendEntry(state, "notice", event.lines.join("\n")) : state;
  }
  if (event.kind === "thinking-delta") return appendThinkingDelta(state, event.text);
  if (event.kind === "assistant-delta") return appendAssistantDelta(collapseOpenThinking(state), event.text);
  if (event.kind === "assistant-text") return finalizeAssistant(collapseOpenThinking(state), event.text);
  if (event.kind === "tool-start") {
    // Collapse open CoT before tools so Thinking… never shares a visual line with ⚙ rows
    // (terminal overwrite artifacts like "Thought for 45sn\":\"**/*").
    const base = collapseOpenThinking(state);
    return {
      ...base,
      entries: [...base.entries, {
        id: nextEntryId(),
        kind: "tool" as const,
        text: "",
        title: event.name,
        detail: event.detail,
        output: "",
        previewCollapsed: true,
        ...(event.callId ? { callId: event.callId } : {}),
      }],
    };
  }
  if (event.kind === "tool-end") return finalizeTool(state, event);
  if (event.kind.startsWith("subagent-")) return state;
  if (event.kind === "notice") return appendEntry(state, "notice", event.text, event.level === "error");
  return state;
}

function handleConfirmInput(options: Readonly<{
  character: string;
  key: Readonly<{ escape?: boolean; return: boolean; upArrow?: boolean; downArrow?: boolean; pageUp?: boolean; pageDown?: boolean }>;
  bridge: TuiSessionBridge;
  scrollConfirm: (delta: number) => void;
}>): void {
  const answer = options.character.trim().toLowerCase();
  if (answer === "y") {
    options.bridge.answerConfirmation(true);
    return;
  }
  if (answer === "n" || options.key.escape || options.key.return) {
    options.bridge.answerConfirmation(false);
    return;
  }
  if (options.key.upArrow || options.key.pageUp) options.scrollConfirm(options.key.pageUp ? -10 : -1);
  if (options.key.downArrow || options.key.pageDown) options.scrollConfirm(options.key.pageDown ? 10 : 1);
}

function handleSelectInput(options: Readonly<{
  character: string;
  key: Readonly<{ escape?: boolean; return: boolean; upArrow?: boolean; downArrow?: boolean }>;
  bridge: TuiSessionBridge;
  moveSelect: (delta: number) => void;
}>): void {
  if (options.key.escape || options.character.trim().toLowerCase() === "q") {
    options.bridge.answerSelect(undefined);
    return;
  }
  if (options.key.upArrow) {
    options.moveSelect(-1);
    return;
  }
  if (options.key.downArrow) {
    options.moveSelect(1);
    return;
  }
  if (options.key.return) {
    // App state holds selected index; bridge needs the value from the latest select event via a side channel.
    // We resolve by reading from a module-level holder set by moveSelection/reduceEvent.
    const value = takeSelectedValue();
    options.bridge.answerSelect(value);
  }
}

function handlePromptInput(options: Readonly<{
  character: string;
  key: Readonly<{ escape?: boolean; return: boolean; backspace: boolean; delete: boolean; ctrl: boolean; meta: boolean }>;
  bridge: TuiSessionBridge;
  setPromptValue: (value: string) => void;
}>): void {
  if (options.key.escape) {
    options.bridge.answerPrompt(undefined);
    return;
  }
  if (options.key.return) {
    const value = takePromptDraft().trim();
    options.bridge.answerPrompt(value.length > 0 ? value : undefined);
    return;
  }
  if (options.key.backspace || options.key.delete) {
    const current = takePromptDraft();
    const next = [...current].slice(0, -1).join("");
    setPromptDraftValue(next);
    options.setPromptValue(next);
    return;
  }
  if (!options.key.ctrl && !options.key.meta && options.character.length > 0 && !/[\r\n]/.test(options.character)) {
    const next = takePromptDraft() + options.character;
    setPromptDraftValue(next);
    options.setPromptValue(next);
  }
}

/** Selected choice value mirrored for Enter handling without stale React closures. */
let selectedValueHolder: string | undefined;
let promptDraftHolder = "";

function takeSelectedValue(): string | undefined {
  return selectedValueHolder;
}

function takePromptDraft(): string {
  return promptDraftHolder;
}

function setPromptDraftValue(value: string): void {
  promptDraftHolder = value;
}

function scrollConfirmation(state: ViewState, delta: number): ViewState {
  if (!state.confirm) return state;
  return { ...state, confirm: { ...state.confirm, scroll: Math.max(0, state.confirm.scroll + delta) } };
}

function moveSelection(state: ViewState, delta: number): ViewState {
  if (!state.select) return state;
  const max = Math.max(0, state.select.choices.length - 1);
  const selected = Math.min(max, Math.max(0, state.select.selected + delta));
  selectedValueHolder = state.select.choices[selected]?.value;
  return { ...state, select: { ...state.select, selected } };
}

function setPromptDraft(state: ViewState, value: string): ViewState {
  if (!state.prompt) return state;
  promptDraftHolder = value;
  return { ...state, prompt: { ...state.prompt, value } };
}

function appendThinkingDelta(state: ViewState, text: string): ViewState {
  const last = state.entries.at(-1);
  if (last?.kind === "thinking" && last.collapsed !== true) {
    return {
      ...state,
      entries: [...state.entries.slice(0, -1), { ...last, text: last.text + text }],
    };
  }
  return {
    ...state,
    entries: [...state.entries, {
      id: nextEntryId(),
      kind: "thinking" as const,
      text,
      collapsed: false,
      startedAt: Date.now(),
    }],
  };
}

function collapseOpenThinking(state: ViewState): ViewState {
  let changed = false;
  const now = Date.now();
  const entries = state.entries.map((entry) => {
    if (entry.kind === "thinking" && entry.collapsed !== true && entry.text.length > 0) {
      changed = true;
      const startedAt = entry.startedAt ?? now;
      return {
        ...entry,
        collapsed: true,
        thoughtSeconds: Math.max(1, Math.round((now - startedAt) / 1000)),
      };
    }
    return entry;
  });
  return changed ? { ...state, entries } : state;
}

function appendAssistantDelta(state: ViewState, text: string): ViewState {
  const last = state.entries.at(-1);
  if (last?.kind !== "assistant") return appendEntry(state, "assistant", text);
  return { ...state, entries: [...state.entries.slice(0, -1), { ...last, text: last.text + text }] };
}

function finalizeAssistant(state: ViewState, text: string): ViewState {
  const last = state.entries.at(-1);
  if (last?.kind === "assistant") return state;
  return text.length > 0 ? appendEntry(state, "assistant", text) : state;
}

function finalizeTool(
  state: ViewState,
  event: Extract<TuiEvent, { kind: "tool-end" }>,
): ViewState {
  const output = event.output ?? "";
  const patch = {
    text: event.error ? "failed" : "done",
    error: event.error,
    output,
    previewCollapsed: true,
    ...(event.callId ? { callId: event.callId } : {}),
  } as const;

  // 1) Prefer exact tool_call id (parallel same-name tools).
  if (event.callId) {
    for (let index = state.entries.length - 1; index >= 0; index -= 1) {
      const entry = state.entries[index]!;
      if (entry.kind !== "tool" || (entry.output ?? "") !== "") continue;
      if (entry.callId !== event.callId) continue;
      const next = [...state.entries];
      next[index] = { ...entry, ...patch };
      return { ...state, entries: next };
    }
  }

  // 2) Fallback: latest unfinished tool with the same name (missing/mismatched ids).
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index]!;
    if (entry.kind !== "tool" || (entry.output ?? "") !== "") continue;
    if (entry.title !== event.name) continue;
    const next = [...state.entries];
    next[index] = { ...entry, ...patch };
    return { ...state, entries: next };
  }

  // 3) No open start row — still show the finished tool with its body.
  return {
    ...state,
    entries: [...state.entries, {
      id: nextEntryId(),
      kind: "tool" as const,
      title: event.name,
      detail: "",
      ...patch,
    }],
  };
}

/** Exported for unit tests of Ctrl+O expand/collapse. */
export function toggleLatestExpandable(state: ViewState): ViewState {
  // Prefer latest tool body (Ctrl+O), then thinking fold.
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index]!;
    if (entry.kind === "tool" && (entry.output?.length ?? 0) > 0) {
      const next = [...state.entries];
      next[index] = { ...entry, previewCollapsed: !entry.previewCollapsed };
      return { ...state, entries: next };
    }
  }
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index]!;
    if (entry.kind === "thinking" && entry.text.length > 0) {
      const next = [...state.entries];
      next[index] = { ...entry, collapsed: !entry.collapsed };
      return { ...state, entries: next };
    }
  }
  return state;
}

function appendEntry(state: ViewState, kind: TranscriptEntry["kind"], text: string, error = false): ViewState {
  return { ...state, entries: [...state.entries, { id: nextEntryId(), kind, text, error }] };
}

function reduceContextCompaction(
  state: ViewState,
  event: ContextCompactionUiEvent,
): ViewState {
  const statuses = { ...state.statuses };
  if (event.stage === "start") {
    statuses.context = "compacting...";
    return { ...state, statuses };
  }
  delete statuses.context;
  if (event.stage === "success") {
    return appendEntry(
      { ...state, statuses },
      "notice",
      `Context compacted: ${event.before} -> ${event.after} messages.`,
    );
  }
  if (event.stage === "skip") {
    return appendEntry({ ...state, statuses }, "notice", "Context is already compact.");
  }
  return appendEntry(
    { ...state, statuses },
    "notice",
    `Context compaction failed: ${event.error}`,
    true,
  );
}

let entryId = 0;
function nextEntryId(): number {
  entryId += 1;
  return entryId;
}

function TranscriptRow({ entry }: Readonly<{ entry: TranscriptEntry }>): React.JSX.Element {
  if (entry.kind === "thinking") {
    return renderThinkingRow(entry);
  }
  if (entry.kind === "tool") {
    return renderToolRow(entry);
  }
  if (entry.kind === "user" || entry.kind === "command") {
    const bar = theme.userBar;
    return h(Box, { width: "100%", backgroundColor: bar, paddingX: 1, marginBottom: 1 },
      h(Text, { backgroundColor: bar }, `${theme.sym.prompt} `),
      h(Text, { backgroundColor: bar, wrap: "wrap" }, entry.text));
  }
  if (entry.kind === "assistant") {
    // Main-agent final answer — highest visual weight.
    return h(Box, { flexDirection: "column", marginTop: 1, marginBottom: 1 },
      h(Box, null,
        h(Text, { color: theme.accent, bold: true }, `${theme.sym.answer} `),
        h(Text, { bold: true, wrap: "wrap" }, entry.text)));
  }
  if (entry.text.startsWith("* ")) {
    return h(Text, { dimColor: true }, entry.text);
  }
  const color = entry.error ? theme.error : undefined;
  return h(Box, null,
    h(Text, { color, dimColor: !entry.error }, `${theme.sym.meta} `),
    h(Text, { color, dimColor: !entry.error, wrap: "wrap" }, entry.text));
}

function renderThinkingRow(entry: TranscriptEntry): React.JSX.Element {
  const label = thoughtLabel(entry);
  // Dedicated row + prefix so collapse never visually merges with following ⚙ lines.
  if (entry.collapsed) {
    return h(Box, { marginY: 0, flexShrink: 0 },
      h(Text, { color: theme.think, dimColor: true }, `${theme.sym.think} ${label}`));
  }
  return h(Box, { flexDirection: "column", marginBottom: 0, flexShrink: 0 },
    h(Text, { color: theme.think, dimColor: true }, `${theme.sym.think} ${label}`),
    h(Text, { color: theme.think, dimColor: true, wrap: "wrap" },
      indentBlock(entry.text, "  ")));
}

function renderToolRow(entry: TranscriptEntry): React.JSX.Element {
  const rawTitle = entry.title ?? "tool";
  const explore = isExploreTool(rawTitle);
  const mark = explore ? theme.sym.explore : theme.sym.tool;
  const color = entry.error ? theme.error : explore ? theme.explore : theme.tool;
  const detailRaw = entry.detail?.trim() ?? "";
  const detail = detailRaw.length > 0 ? ` ${truncateToolDetail(detailRaw)}` : "";
  const finished = entry.text === "done" || entry.text === "failed";
  const title = explore
    ? formatExploreToolLabel({
      running: !finished,
      status: entry.text === "failed" ? "failed" : entry.text === "done" ? "done" : "…",
    })
    : rawTitle;
  const status = explore ? "" : (entry.text ? ` ${entry.text}` : " …");
  const output = entry.output ?? "";
  const bodyLines = formatToolOutputBody(output, entry.previewCollapsed !== false, finished);
  const showExpand = entry.previewCollapsed === true && output.length > 0;

  return h(Box, { flexDirection: "column", marginY: 0, flexShrink: 0 },
    h(Text, {
      color,
      dimColor: !entry.error,
      wrap: "wrap",
    }, `${mark} ${title}${detail}${status}`),
    ...bodyLines.map((line, index) =>
      h(Text, {
        key: `out-${index}`,
        color: entry.error ? theme.error : undefined,
        dimColor: true,
        wrap: "wrap",
      }, line)),
    showExpand
      ? h(Text, { dimColor: true }, `  ${theme.sym.nest} … (${formatToolExpandHint(output.split("\n").length)})`)
      : null);
}

/** Explore tool = primary→worker fan-out; label as subagent row. */
export function isExploreTool(name: string | undefined): boolean {
  return isExploreToolName(name);
}

export function thoughtLabel(entry: Readonly<{ collapsed?: boolean; thoughtSeconds?: number }>): string {
  if (entry.collapsed) {
    const seconds = entry.thoughtSeconds;
    return typeof seconds === "number" && seconds > 0
      ? `Thought for ${seconds}s`
      : "Thought";
  }
  return "Thinking…";
}

/** Tool output under the title: collapsed = no body (Ctrl+O); expanded = full. */
export function formatToolOutputBody(
  output: string,
  previewCollapsed: boolean,
  finished: boolean,
): readonly string[] {
  if (!finished && output.length === 0) return [];
  const display = formatToolOutputForDisplay(output) || output;
  if (display.length === 0) {
    return finished ? [`  ${theme.sym.nest} (empty)`] : [];
  }
  // Default collapsed: keep Static / Route A short so scrollback can reach the start.
  if (previewCollapsed) return [];
  return indentBlock(display, `  ${theme.sym.nest} `).split("\n");
}

function indentBlock(text: string, prefix: string): string {
  if (text.length === 0) return text;
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

/** Header chrome for the current turn: requesting → streaming → tool-use. */
export function busyPhaseLabel(input: Readonly<{
  busy: boolean;
  inFlightToolCount: number;
  inFlightSubagentCount?: number;
  liveKind?: "thinking" | "assistant";
}>): string | undefined {
  if (!input.busy) return undefined;
  if ((input.inFlightSubagentCount ?? 0) > 0) return "agents…";
  if (input.inFlightToolCount > 0) return "tools…";
  if (input.liveKind === "assistant" || input.liveKind === "thinking") return "streaming…";
  return "working…";
}

/** Prefix the header phase with the shared spinner frame (motion on + busy only). */
export function composePhaseChrome(
  label: string | undefined,
  spinnerFrame: string | undefined,
): string | undefined {
  if (label === undefined) return undefined;
  return spinnerFrame ? `${spinnerFrame} ${label}` : label;
}

const SessionHeader = memo(function SessionHeader(props: Readonly<{
  version: string;
  model: string;
  thinking: string;
  plan?: string;
  cwd: string;
  busy?: boolean;
  /** Turn phase chrome: working… / streaming… / tools… / agents… */
  phase?: string;
}>): React.JSX.Element {
  // Path / permission / usage / workspace live in the Claude-style footer;
  // header mirrors CondensedLogo: mascot + title / meta / cwd.
  const parts = [
    props.model,
    props.thinking,
    props.plan,
    props.phase ?? (props.busy ? "working…" : undefined),
  ].filter((part): part is string => typeof part === "string" && part.length > 0);

  return h(BrandHeader, {
    version: props.version,
    meta: parts.length > 0 ? parts.join(` ${theme.sym.meta} `) : undefined,
    path: formatShortCwd(props.cwd),
  });
});

export {
  BUILTIN_SLASH_COMMANDS,
  CommandPalette,
  ConfirmView,
  FileMenu,
  FooterHints,
  SLASH_MENU_VISIBLE,
  SlashMenu,
  SubagentDetailOverlay,
  TasklistPanel,
  TranscriptViewerOverlay,
  VIEWER_CHROME_ROWS,
  collectSlashCommands,
  filterSlashCommands,
  formatExploreFooter,
  formatMcpFooter,
  formatWorkspaceFooter,
  isDefaultPermissionMode,
  slashQuery,
  viewerScrollBounds,
};


function SelectView(props: Readonly<{
  select: NonNullable<ViewState["select"]>;
  rows: number;
}>): React.JSX.Element {
  selectedValueHolder = props.select.choices[props.select.selected]?.value;
  const visibleCount = Math.max(4, props.rows - 5);
  const start = Math.min(
    Math.max(0, props.select.selected - visibleCount + 1),
    Math.max(0, props.select.choices.length - visibleCount),
  );
  const visible = props.select.choices.slice(start, start + visibleCount);
  return h(Box, { flexDirection: "column", flexGrow: 1 },
    h(Text, { bold: true }, props.select.question),
    ...visible.map((choice, index) => {
      const active = start + index === props.select.selected;
      const marker = active ? `${theme.sym.select} ` : "  ";
      return h(Text, {
        key: `${choice.value}-${start + index}`,
        color: active ? theme.accent : undefined,
        dimColor: !active,
        wrap: "truncate-end",
      }, `${marker}${choice.label}`);
    }),
    h(Text, { dimColor: true }, "↑/↓ select · Enter confirm · Esc cancel"));
}

function PromptView(props: Readonly<{ prompt: NonNullable<ViewState["prompt"]> }>): React.JSX.Element {
  promptDraftHolder = props.prompt.value;
  return h(Box, { flexDirection: "column", flexGrow: 1 },
    h(Text, { bold: true }, props.prompt.question),
    h(Text, { dimColor: true }, props.prompt.secret
      ? "Secret input (masked) · Enter submit · Esc cancel"
      : "Enter submit · Esc cancel"));
}

function maskPromptDisplay(prompt: NonNullable<ViewState["prompt"]>): string {
  if (!prompt.secret) return prompt.value;
  return "*".repeat([...prompt.value].length);
}

function formatResult(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

function createInitialView(messages: readonly ChatMessage[]): ViewState {
  const entries = messages.flatMap((message): TranscriptEntry[] => {
    if (message.role === "system") {
      if (message.name === CONTEXT_SUMMARY_NAME) {
        return [{ id: nextEntryId(), kind: "notice", text: "Earlier context was compacted." }];
      }
      if (message.name === SESSION_RECOVERY_NAME) {
        return [{ id: nextEntryId(), kind: "notice", text: message.content }];
      }
      return [];
    }
    const kind = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "tool";
    return [{ id: nextEntryId(), kind, text: message.content }];
  });
  return { entries, statuses: {}, widgets: {} };
}
