import { createRequire } from "node:module";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useWindowSize } from "ink";

import { copyTextToClipboard } from "./clipboard.ts";
import {
  estimateContentBottomRow,
  estimateContentTopRow,
  extractSelectedText,
  selectionIsEmpty,
  stripAnsi,
  type TextSelectionRange,
} from "./text-selection.ts";
import type { PreparedSession } from "../runtime/session.ts";
import type { TuiEvent, TuiSessionBridge } from "./session-bridge.ts";
import {
  blocksFromRestoredMessages,
  expandableHistoryBlocks,
  formatLiveLines,
  reduceScrollback,
  sliceTranscriptLineWindow,
  type HistoryBlock,
  type RenderLine,
  type ScrollbackState,
} from "./transcript-log.ts";
import { createDeltaCoalescer, mergeSoftDeltas } from "./delta-coalesce.ts";
import { motionEnabled, REDUCED_TICK_MS, SPINNER_INTERVAL_MS, spinnerFrameAt } from "./motion.ts";
import { theme } from "./theme.ts";
import { composerHint, shortcutGroups, ShortcutsOverlay } from "./shortcuts.ts";
import { computeViewportHeight } from "./chrome-metrics.ts";
import { RewindPickerOverlay } from "./rewind-picker.ts";
import { isConnected, WelcomePanel, type RecentSession } from "./welcome.ts";
import { t } from "../i18n/messages.ts";
import { thinkingStatusLabel } from "../runtime/thinking.ts";
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
import {
  ComposerChrome,
  InputCandidateRegion,
  PromptView,
  SelectView,
  SessionHeader,
  busyPhaseLabel,
  composePhaseChrome,
  maskPromptDisplay,
} from "./app-chrome.ts";
import { useSessionInteraction } from "./app-interaction.ts";
import {
  HistoryBlockRow,
  LiveStreamRegion,
  RenderLineRow,
  ReviewOverlay,
  SearchBar,
  livePreviewCharBudget,
  wrappedLineCount,
} from "./app-transcript.ts";
import { type ViewState, reduceEvent } from "./app-view-state.ts";

// Public surface kept on app.ts for existing importers (tests, perf fixtures).
export { ComposerChrome, InputCandidateRegion, busyPhaseLabel, composePhaseChrome } from "./app-chrome.ts";
export { HistoryBlockRow, LiveStreamRegion, livePreviewCharBudget, type SearchState } from "./app-transcript.ts";
export { reduceEvent, type SelectState, type ViewState } from "./app-view-state.ts";

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
  /** This repository's latest sessions for the welcome screen (new sessions only). */
  recentSessions?: Promise<readonly RecentSession[]>;
}>;

export type { SlashCommand };

/** Process-wide reduced-motion preference (TERM=dumb / XIO_ANIMATION=off). */
export function isMotionActive(): boolean {
  return motionEnabled();
}

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
    ({ statuses: {}, widgets: {} }),
  );
  // Canonical transcript for Static (route B) and windowed fullscreen (route A).
  const [scrollback, setScrollback] = useState<ScrollbackState>(() =>
    blocksFromRestoredMessages(props.session.getMessages()),
  );
  const [subagentClock, setSubagentClock] = useState(() => Date.now());
  const [recentSessions, setRecentSessions] = useState<readonly RecentSession[]>([]);
  useEffect(() => {
    let live = true;
    props.recentSessions?.then(
      (sessions) => { if (live) setRecentSessions(sessions); },
      (error: unknown) => props.bridge.sink.notify?.(
        t("welcome.recentError", { error: error instanceof Error ? error.message : String(error) }),
        "warning",
      ),
    );
    return () => { live = false; };
  }, [props.recentSessions, props.bridge]);
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
        // A widget other than the tasklist panel has no slot of its own: show it as a notice.
        if (event.kind === "widget" && event.key !== "tasklist" && event.lines && event.lines.length > 0) {
          const text = event.lines.join("\n");
          setScrollback((current) => reduceScrollback(current, { kind: "notice", text }));
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
      result.ok ? t("status.copied", { count: text.length }) : t("status.copyFailed"),
    );
    setTimeout(() => {
      props.bridge.sink.setStatus?.("clipboard", undefined);
    }, 1200);
  };
  selectionApiRef.current.setTextSelection = setTextSelection;

  const {
    input,
    slashDismissed,
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
    rewindPicker,
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
  const motionActive = isMotionActive();
  useEffect(() => {
    if (!busy && scrollback.inFlightSubagents.length === 0) return;
    const tickMs = motionActive ? SPINNER_INTERVAL_MS : REDUCED_TICK_MS;
    setSubagentClock(Date.now());
    const timer = setInterval(() => setSubagentClock(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [busy, scrollback.inFlightSubagents.length, motionActive]);
  const spinnerFrame = motionActive && busy ? spinnerFrameAt(subagentClock) : undefined;

  const slashItems = useMemo(
    () => slashDismissed === input
      ? undefined
      : filterSlashCommands(collectSlashCommands(props.session.host), slashQuery(input)),
    [props.session.host, input, slashDismissed],
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
    // chrome rows (BASE_CHROME_ROWS). The ↑ above / ↓ to latest hints render inside the content
    // band, so reserve their rows when scrolled: without this the window + hints
    // overflow the band and ink drops children (a visible line disappears).
    const hintRows = scrollOffset > 0 ? 2 : 0;
    const extraChrome = menuRows + tasklistRows + liveExtra + hintRows;
    const viewportLines = computeViewportHeight(rows, extraChrome);
    return sliceTranscriptLineWindow(scrollback.blocks, viewportLines, scrollOffset, foldedBlockIds, columns);
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
  const thinkingLabel = view.statuses.thinking ?? thinkingStatusLabel(props.session.getThinkingLevel());
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

  // Welcome screen until the conversation starts: notices (recovery, theme, update) no longer shrink it.
  // Fixed-height overlays size themselves to the screen without the tips, so the tips step aside.
  const welcome = !busy && scrollback.blocks.every((block) => block.kind === "notice")
    && !shortcutsOpen && !transcriptViewer && !review && !palette && !rewindPicker;
  return h(Box, rootProps,
    h(SessionHeader, {
      compact: !welcome,
      version: PACKAGE_VERSION,
      model: modelLabel,
      thinking: thinkingLabel,
      plan: planLabel,
      columns,
      busy,
      phase: composePhaseChrome(busyPhaseLabel({
        busy,
        inFlightToolCount: scrollback.inFlightTools.length,
        inFlightSubagentCount: scrollback.inFlightSubagents.length,
        liveKind: scrollback.live?.kind,
      }), spinnerFrame),
    }),
    welcome
      ? h(WelcomePanel, { connected: isConnected(modelLabel), recent: recentSessions, columns })
      : null,
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
        columns,
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
        : view.select?.detail !== undefined
          ? h(ConfirmView, { confirm: view.select, rows })
          : view.select
            ? h(SelectView, { select: view.select, rows, columns })
            : view.prompt
              ? h(PromptView, { prompt: view.prompt })
              : h(Box, { flexDirection: "column", flexGrow: 1 },
                search && !appendScrollback
                  ? h(SearchBar, { search, totalLines: window.totalLines })
                  : null,
                !appendScrollback && scrolled
                  ? h(Text, { color: theme.muted },
                    t("window.above", { count: window.hiddenAbove }))
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
                  ? h(Text, { color: theme.muted }, t("window.below", { count: window.hiddenBelow }))
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
      candidateMenu: rewindPicker
        ? h(RewindPickerOverlay, { state: rewindPicker })
        : palette
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
      columns,
      context: view.statuses.clipboard ?? view.statuses.context,
      usage: view.statuses.usage,
      explore: view.statuses.explore,
      workspace: workspaceLabel,
      mcp: view.statuses.mcp,
      turn: scrollback.blocks.filter((block) => block.kind === "user").length,
    }));
}

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
