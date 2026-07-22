import { createRequire } from "node:module";

import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useWindowSize } from "ink";

import {
  formatExploreToolLabel,
  formatToolExpandHint,
  formatToolOutputForDisplay,
  isExploreToolName,
} from "../runtime/session-ui.ts";
import { isMouseLeakChunk, stripMouseLeak } from "./mouse-scroll.ts";
import {
  atQuery,
  expandFileMentions,
  filterFiles,
  insertFileMention,
  listWorkspaceFiles,
} from "./file-mention.ts";
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
  emptyComposer,
  historyDown,
  historyUp,
  loadQueueIntoDraft,
  moveCursor,
  moveCursorLine,
  parseBusySubmitIntent,
  queueWhileBusy,
  rememberSubmission,
  setComposerText,
  sliceViewerWindow,
  type ComposerState,
} from "./composer.ts";
import {
  appendUserBlock,
  blocksFromRestoredMessages,
  emptyScrollbackState,
  formatLiveLines,
  isExploreHistoryBlock,
  latestExpandableToolBlock,
  reduceScrollback,
  toggleLatestScrollbackExpandable,
  type HistoryBlock,
  type ScrollbackState,
} from "./transcript-log.ts";
import { createDeltaCoalescer, mergeSoftDeltas } from "./delta-coalesce.ts";
import type { ChatMessage, ContextCompactionUiEvent } from "../runtime/types.ts";
import {
  collapseNoticesForDisplay,
  formatShortCwd,
  padSlashName,
  theme,
  truncateToolDetail,
} from "./theme.ts";

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
  bypass: boolean;
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

export type SlashCommand = Readonly<{ name: string; description: string }>;

const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", description: "Show available commands." },
  { name: "bypass", description: "Toggle merge/rollback auto-approve for this session." },
  { name: "exit", description: "End the session." },
  { name: "quit", description: "Alias for /exit." },
];

const SLASH_MENU_VISIBLE = 8;

export function App(props: AppProps): React.JSX.Element {
  const { rows } = useWindowSize();
  const appendScrollback = props.appendScrollback === true;
  const [view, setView] = useState<ViewState>(() =>
    appendScrollback
      ? { entries: [], statuses: {}, widgets: {}, bypass: false }
      : createInitialView(props.session.getMessages()),
  );
  // Route B: finalized blocks → <Static>; live stream + in-flight tools stay sticky above the prompt.
  const [scrollback, setScrollback] = useState<ScrollbackState>(() =>
    appendScrollback
      ? blocksFromRestoredMessages(props.session.getMessages())
      : emptyScrollbackState(),
  );
  // Route A only: 0 = stick to latest; >0 = lines scrolled up in self-viewport.
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    const applyBridgeEvent = (event: TuiEvent) => {
      if (appendScrollback) {
        // Chrome status/modals still via reduceEvent; transcript via scrollback state.
        if (
          event.kind === "status"
          || event.kind === "widget"
          || event.kind === "confirm-open"
          || event.kind === "confirm-close"
          || event.kind === "select-open"
          || event.kind === "select-close"
          || event.kind === "prompt-open"
          || event.kind === "prompt-close"
          || event.kind === "bypass"
        ) {
          setView((current) => reduceEvent(current, event));
          return;
        }
        setScrollback((current) => reduceScrollback(current, event));
        return;
      }
      setView((current) => reduceEvent(current, event));
    };

    const coalescer = createDeltaCoalescer((events) => {
      const batch = mergeSoftDeltas(events);
      for (const event of batch) applyBridgeEvent(event);
    });

    const unsubscribe = props.bridge.subscribe((event) => {
      if (appendScrollback) {
        coalescer.push(event);
        return;
      }
      // Route A (tests): apply immediately for deterministic reducers.
      applyBridgeEvent(event);
    });
    return () => {
      coalescer.dispose();
      unsubscribe();
    };
  }, [props.bridge, appendScrollback]);

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
  } = useSessionInteraction(
    props,
    setView,
    setScrollOffset,
    appendScrollback,
    setScrollback,
    scrollback,
  );

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
  const collapsedEntries = useMemo(
    () => collapseNoticesForDisplay(view.entries),
    [view.entries],
  );

  // --- Route A (tests / optional): self-managed line window ---
  const window = useMemo(() => {
    if (appendScrollback) {
      return {
        visible: [] as typeof collapsedEntries,
        offset: 0,
        maxOffset: 0,
        hiddenAbove: 0,
        hiddenBelow: 0,
        viewport: 0,
        totalLines: 0,
      };
    }
    const tasklistRows = tasklist && tasklist.length > 0 ? Math.min(tasklist.length, 10) + 3 : 0;
    const menuRows = slashOpen
      ? Math.min(SLASH_MENU_VISIBLE, slashItems?.length ?? 0) + 1
      : atOpen
        ? Math.min(SLASH_MENU_VISIBLE, atItems?.length ?? 0) + 1
        : 0;
    const baseChrome = 7 + menuRows + tasklistRows;
    const viewportLines = Math.max(4, rows - baseChrome);
    return sliceTranscriptWindow(
      collapsedEntries,
      viewportLines,
      scrollOffset,
      (entry) => estimateTranscriptEntryLines(entry, 80),
    );
  }, [appendScrollback, collapsedEntries, rows, scrollOffset, slashOpen, slashItems, atOpen, atItems, tasklist]);

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

  // Scrollback mode: natural height (Static history + chrome). Do not pin to full screen.
  const rootProps = appendScrollback
    ? { flexDirection: "column" as const }
    : { flexDirection: "column" as const, height: rows };

  return h(Box, rootProps,
    appendScrollback
      ? h(Static as React.FC<{ items: HistoryBlock[]; children: (block: HistoryBlock) => React.ReactNode }>, {
        // Ink Static mutates its items prop type; blocks array is only replaced on hard boundaries.
        items: scrollback.blocks as HistoryBlock[],
        children: (block: HistoryBlock) => h(HistoryBlockRow, { key: block.id, block }),
      })
      : null,
    h(SessionHeader, {
      version: PACKAGE_VERSION,
      model: modelLabel,
      thinking: thinkingLabel,
      plan: planLabel,
      busy,
      phase: busyPhaseLabel({
        busy,
        inFlightToolCount: scrollback.inFlightTools.length,
        liveKind: scrollback.live?.kind,
      }),
    }),
    transcriptViewer
      ? h(TranscriptViewerOverlay, {
        block: transcriptViewer,
        rows,
        scrollOffset: viewerScrollOffset,
        onClose: () => setTranscriptViewer(undefined),
      })
      : view.confirm
        ? h(ConfirmView, { confirm: view.confirm, rows })
        : view.select
          ? h(SelectView, { select: view.select, rows })
          : view.prompt
            ? h(PromptView, { prompt: view.prompt })
            : appendScrollback
              ? h(LiveStreamRegion, {
                live: scrollback.live,
                inFlightTools: scrollback.inFlightTools,
                inFlightSubagents: scrollback.inFlightSubagents,
              })
              : h(Box, { flexDirection: "column", flexGrow: 1 },
                scrolled
                  ? h(Text, { dimColor: true },
                    `↑ ${window.hiddenAbove} lines above · PgUp/PgDn · ↓ latest`)
                  : null,
                ...window.visible.map((entry) => h(TranscriptRow, { key: entry.id, entry })),
                window.hiddenBelow > 0
                  ? h(Text, { dimColor: true }, `↓ ${window.hiddenBelow} lines to latest`)
                  : null),
    tasklist && tasklist.length > 0
      ? h(TasklistPanel, { lines: tasklist.slice(0, 10) })
      : null,
    h(ComposerChrome, {
      busy,
      composer: view.prompt ? { ...composer, text: maskPromptDisplay(view.prompt), cursor: maskPromptDisplay(view.prompt).length } : composer,
    }),
    slashOpen
      ? h(SlashMenu, { items: slashItems ?? [], selected: safeSlashIndex })
      : null,
    atOpen
      ? h(FileMenu, { items: atItems ?? [], selected: safeAtIndex })
      : null,
    h(FooterHints, {
      bypass: view.bypass || Boolean(view.statuses.bypass),
      permissionMode,
      cwd: props.cwd,
      context: view.statuses.context,
      usage: view.statuses.usage,
      explore: view.statuses.explore,
      workspace: workspaceLabel,
      mcp: view.statuses.mcp,
    }));
}

/** Sticky live stream — only re-renders when live buffer / in-flight tools change. */
const LiveStreamRegion = memo(function LiveStreamRegion(props: Readonly<{
  live: ScrollbackState["live"];
  inFlightTools: ScrollbackState["inFlightTools"];
  inFlightSubagents: ScrollbackState["inFlightSubagents"];
}>): React.JSX.Element | null {
  const liveLines = formatLiveLines(props.live, props.inFlightTools, props.inFlightSubagents);
  if (liveLines.length === 0) return null;
  return h(Box, { flexDirection: "column", marginY: 0 },
    ...liveLines.map((line, index) =>
      h(Text, {
        key: `live-${index}`,
        dimColor: true,
        wrap: "wrap",
        color: line.includes(theme.sym.think)
          ? theme.think
          : line.includes(theme.sym.explore)
            ? theme.explore
            : line.includes(theme.sym.tool)
              ? theme.tool
              : undefined,
      }, line)));
});

/** Composer with block cursor and multiline draft (pi Editor-style subset). */
const ComposerChrome = memo(function ComposerChrome(props: Readonly<{
  busy: boolean;
  composer: ComposerState;
}>): React.JSX.Element {
  const { text, cursor } = props.composer;
  const lines = text.length === 0 ? [""] : text.split("\n");
  let offset = 0;
  const rows = lines.map((line, rowIndex) => {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    if (rowIndex < lines.length - 1) offset = lineEnd + 1;
    else offset = lineEnd;
    const onCursorLine = cursor >= lineStart && cursor <= lineEnd;
    if (!onCursorLine) {
      return h(Text, { key: `composer-${rowIndex}`, wrap: "wrap" }, ` ${line}`);
    }
    const col = cursor - lineStart;
    const before = line.slice(0, col);
    const after = line.slice(col);
    const cursorChar = after.length > 0 ? after.charAt(0) : " ";
    const rest = after.length > 1 ? after.slice(1) : "";
    return h(Text, { key: `composer-${rowIndex}`, wrap: "wrap" },
      " ",
      before,
      h(Text, { inverse: true, color: theme.accent }, cursorChar),
      rest);
  });
  return h(Box, {
    marginTop: 1,
    flexDirection: "column",
    borderStyle: "round",
    borderColor: "gray",
    paddingX: 1,
  },
    h(Text, { dimColor: props.busy }, props.busy ? theme.sym.busy : theme.sym.prompt),
    ...rows);
});

const HistoryBlockRow = memo(function HistoryBlockRow(
  props: Readonly<{ block: HistoryBlock }>,
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
  const dim = props.block.kind === "tool"
    || props.block.kind === "thinking"
    || props.block.kind === "notice"
    || props.block.kind === "subagent";
  return h(Box, { flexDirection: "column", flexShrink: 0 },
    ...props.block.lines.map((line, index) =>
      h(Text, {
        key: `${props.block.id}-${index}`,
        color,
        bold: bold && index === 0,
        dimColor: dim,
        wrap: "wrap",
      }, line)));
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

function useSessionInteraction(
  props: AppProps,
  setView: React.Dispatch<React.SetStateAction<ViewState>>,
  setScrollOffset: React.Dispatch<React.SetStateAction<number>>,
  appendScrollback: boolean,
  setScrollback: React.Dispatch<React.SetStateAction<ScrollbackState>>,
  scrollback: ScrollbackState,
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
    setViewerScrollOffset((current) => Math.max(0, current + delta));
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
        if (appendScrollback) {
          setScrollback((current) => reduceScrollback(current, { kind: "notice", text: notice }));
        } else {
          setView((current) => appendEntry(current, "notice", notice));
        }
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
        if (appendScrollback) {
          setScrollback((current) => reduceScrollback(current, { kind: "notice", text: notice }));
        } else {
          setView((current) => appendEntry(current, "notice", notice));
        }
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
      if (appendScrollback) {
        setScrollback((current) => reduceScrollback(current, { kind: "notice", text: notice }));
      } else {
        setView((current) => appendEntry(current, "notice", notice));
      }
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
    if (appendScrollback) {
      setScrollback((current) => appendUserBlock(current, value));
    } else {
      setView((current) => appendEntry(current, isCommand ? "command" : "user", value));
    }
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
        if (appendScrollback) {
          setScrollback((current) => reduceScrollback(current, { kind: "notice", text: done }));
        } else {
          setView((current) => appendEntry(current, "notice", done));
        }
      }
      // Restore queued input into the draft so it can be inspected/edited/submitted.
      const queued = composerRef.current.queue;
      if (queued) {
        setComposerState(loadQueueIntoDraft(composerRef.current));
        setView((current) => reduceEvent(current, { kind: "status", key: "queue", text: undefined }));
      }
    }
  };
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
    viewerOpen: () => transcriptViewerRef.current !== undefined,
    appendScrollback,
    moveSelect: (delta) => setView((current) => moveSelection(current, delta)),
    setPromptValue: (value) => setView((current) => setPromptDraft(current, value)),
    toggleExpandable: () => {
      if (appendScrollback) {
        // Toggle overlay closed if already open.
        if (transcriptViewerRef.current) {
          setTranscriptViewer(undefined);
          return;
        }
        const current = scrollbackRef.current;
        const next = toggleLatestScrollbackExpandable(current);
        const block = latestExpandableToolBlock(next);
        setScrollback(next);
        if (block?.output) setTranscriptViewer(block);
        return;
      }
      setView((current) => toggleLatestExpandable(current));
    },
    closeTranscriptViewer: () => {
      if (!transcriptViewerRef.current) return false;
      setTranscriptViewer(undefined);
      return true;
    },
    clearQueued: () => {
      setComposerState(clearQueue(composerRef.current));
      setView((current) => reduceEvent(current, { kind: "status", key: "queue", text: undefined }));
    },
  }));
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
  viewerOpen?: () => boolean;
  appendScrollback?: boolean;
  moveSelect: (delta: number) => void;
  setPromptValue: (value: string) => void;
  toggleExpandable: () => void;
  /** Returns true when an open transcript overlay was closed. */
  closeTranscriptViewer?: () => boolean;
  clearQueued: () => void;
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
  if (options.key.ctrl && options.character === "o") {
    options.toggleExpandable();
    return;
  }
  if (options.key.escape && options.closeTranscriptViewer?.()) {
    return;
  }

  // Transcript viewer (Route B Ctrl+O): scroll full retained output in-overlay.
  if (options.viewerOpen?.()) {
    const step = options.key.pageUp || options.key.pageDown ? 12 : 1;
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

  // Route A only: self-managed transcript scroll. Route B: composer history + cursor.
  if (!options.appendScrollback) {
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
    options.setComposerState(moveCursor(options.composer, -1));
    return;
  }
  if (options.key.rightArrow) {
    options.setComposerState(moveCursor(options.composer, 1));
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
  if (options.key.ctrl && options.character === "u") {
    options.setInputValue("");
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
    if (value === "/bypass") {
      bridge.toggleBypass();
      return;
    }
    if (value.startsWith("/")) {
      const [name, ...args] = value.slice(1).split(/\s+/);
      if (!name) return;
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
  if (event.kind === "bypass") return { ...state, bypass: event.enabled };
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
      ? `think ${seconds}s`
      : "think";
  }
  return "thinking…";
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
  liveKind?: "thinking" | "assistant";
}>): string | undefined {
  if (!input.busy) return undefined;
  if (input.inFlightToolCount > 0) return "tools…";
  if (input.liveKind === "assistant" || input.liveKind === "thinking") return "streaming…";
  return "working…";
}

const SessionHeader = memo(function SessionHeader(props: Readonly<{
  version: string;
  model: string;
  thinking: string;
  plan?: string;
  busy?: boolean;
  /** Turn phase chrome: working… / streaming… / tools… */
  phase?: string;
}>): React.JSX.Element {
  // Path / permission / usage / workspace live in the Claude-style footer.
  const parts = [
    props.model,
    props.thinking,
    props.plan,
    props.phase ?? (props.busy ? "working…" : undefined),
  ].filter((part): part is string => typeof part === "string" && part.length > 0);

  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, null,
      h(Text, { color: theme.brand, bold: true }, `${theme.sym.brand} `),
      h(Text, { bold: true }, `XioCode v${props.version}`)),
    parts.length > 0
      ? h(Text, { dimColor: true, wrap: "truncate-end" }, parts.join(` ${theme.sym.meta} `))
      : null);
});

/** Route B Ctrl+O overlay: full retained tool output without mutating Static history. */
function TranscriptViewerOverlay(props: Readonly<{
  block: HistoryBlock;
  rows: number;
  scrollOffset: number;
  onClose: () => void;
}>): React.JSX.Element {
  const body = props.block.output ?? props.block.lines.join("\n");
  const lines = body.split("\n");
  const viewport = Math.max(6, props.rows - 10);
  const window = sliceViewerWindow(lines, viewport, props.scrollOffset);
  const title = props.block.title
    ? `${props.block.title}${props.block.detail ? ` ${props.block.detail}` : ""}`
    : "tool output";
  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    paddingX: 1,
    marginY: 1,
  },
    h(Text, { bold: true }, `Transcript · ${title}`),
    h(Text, { dimColor: true }, "↑↓/PgUp/PgDn scroll · Ctrl+O/Esc close · full retained output"),
    window.indicator
      ? h(Text, { dimColor: true }, window.indicator)
      : null,
    ...window.visible.map((line, index) =>
      h(Text, {
        key: `tv-${window.offset + index}`,
        color: props.block.error ? theme.error : undefined,
        wrap: "truncate-end",
      }, line || " ")));
}

function TasklistPanel(props: Readonly<{ lines: readonly string[] }>): React.JSX.Element {
  return h(Box, {
    flexDirection: "column",
    marginTop: 1,
    borderStyle: "single",
    borderColor: "gray",
    paddingX: 1,
  },
    ...props.lines.map((line, index) =>
      h(Text, { key: `tl-${index}`, dimColor: index > 0, wrap: "truncate-end" }, line)));
}

/**
 * Claude-style footer: elevate permission only when non-default;
 * always show path + context/usage; workspace/mcp stay dim on the right.
 */
function FooterHints(props: Readonly<{
  bypass: boolean;
  permissionMode: string;
  cwd: string;
  context?: string;
  /** Cumulative session tokens + estimated cost, e.g. "tok:12.3k ~$0.01". */
  usage?: string;
  /** Active explore subagents, e.g. "subs:3". */
  explore?: string;
  workspace?: string;
  mcp?: string;
}>): React.JSX.Element {
  const elevated = props.bypass || !isDefaultPermissionMode(props.permissionMode);
  const modeLabel = props.bypass
    ? "bypass permissions on"
    : `permissions ${props.permissionMode} on`;
  const path = formatShortCwd(props.cwd);
  const contextLabel = props.context ?? props.usage;
  const exploreLabel = props.explore ? formatExploreFooter(props.explore) : undefined;
  const workspaceLabel = formatWorkspaceFooter(props.workspace);
  const mcpLabel = formatMcpFooter(props.mcp);

  const rightParts = [workspaceLabel, mcpLabel].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );

  return h(Box, {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 1,
    marginTop: 1,
  },
    h(Text, { wrap: "truncate-end" },
      elevated
        ? h(React.Fragment, null,
          h(Text, { color: theme.brand }, ">> "),
          h(Text, { color: theme.brand }, modeLabel),
          h(Text, { dimColor: true }, " (shift+tab to cycle)"))
        : h(Text, { dimColor: true }, "? for shortcuts"),
      h(Text, { dimColor: true }, ` ${theme.sym.meta} ${path}`),
      contextLabel
        ? h(Text, { dimColor: true }, ` ${theme.sym.meta} ${contextLabel}`)
        : null,
      exploreLabel
        ? h(Text, { dimColor: true }, ` ${theme.sym.meta} ${exploreLabel}`)
        : null),
    rightParts.length > 0
      ? h(Text, { dimColor: true, wrap: "truncate-end" },
        rightParts.join(` ${theme.sym.meta} `))
      : null);
}

/** Default permission mode stays quiet in the footer (Claude parity). */
export function isDefaultPermissionMode(mode: string): boolean {
  return mode === "auto";
}

/** Map statuses.explore ("subs:3") → "← 3 agents" for footer parity with Claude. */
export function formatExploreFooter(explore: string): string {
  const match = /^subs:(\d+)$/.exec(explore.trim());
  if (!match) return explore;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return explore;
  return `← ${count} agent${count === 1 ? "" : "s"}`;
}

/** Short workspace badge for footer (never scream-red in the header). */
export function formatWorkspaceFooter(workspace?: string): string | undefined {
  if (!workspace) return undefined;
  const lower = workspace.toLowerCase();
  if (lower.includes("worktree")) return "worktree";
  if (lower.includes("direct")) return "direct";
  return workspace;
}

/** Compact MCP status for footer right side. */
export function formatMcpFooter(mcp?: string): string | undefined {
  if (!mcp) return undefined;
  const ready = /^mcp:ready\((\d+)\)$/.exec(mcp.trim());
  if (ready) return `${ready[1]} mcp`;
  const mixed = /^mcp:(\d+)ok\/(\d+)fail$/.exec(mcp.trim());
  if (mixed) return `mcp ${mixed[1]}ok/${mixed[2]}fail`;
  if (mcp.startsWith("mcp:connecting")) return "mcp…";
  return mcp.startsWith("mcp:") ? mcp.slice(4) : mcp;
}

function SlashMenu(props: Readonly<{
  items: readonly SlashCommand[];
  selected: number;
}>): React.JSX.Element {
  if (props.items.length === 0) {
    return h(Text, { dimColor: true }, "No matching commands");
  }
  const start = Math.min(
    Math.max(0, props.selected - SLASH_MENU_VISIBLE + 1),
    Math.max(0, props.items.length - SLASH_MENU_VISIBLE),
  );
  const visible = props.items.slice(start, start + SLASH_MENU_VISIBLE);
  return h(Box, { flexDirection: "column", marginTop: 1 },
    ...visible.map((item, index) => {
      const absolute = start + index;
      const active = absolute === props.selected;
      const nameCol = padSlashName(item.name);
      const label = item.description ? `${nameCol}  ${item.description}` : nameCol;
      const marker = active ? `${theme.sym.select} ` : "  ";
      return h(Text, {
        key: item.name,
        color: active ? theme.accent : undefined,
        dimColor: !active,
        wrap: "truncate-end",
      }, `${marker}${label}`);
    }),
    h(Text, { dimColor: true },
      `(${props.selected + 1}/${props.items.length}) ↑↓ · Tab · Enter`));
}

/** `@` file picker rendered below the composer (same window size as SlashMenu). */
function FileMenu(props: Readonly<{
  items: readonly string[];
  selected: number;
}>): React.JSX.Element {
  if (props.items.length === 0) {
    return h(Text, { dimColor: true }, "No matching files");
  }
  const start = Math.min(
    Math.max(0, props.selected - SLASH_MENU_VISIBLE + 1),
    Math.max(0, props.items.length - SLASH_MENU_VISIBLE),
  );
  const visible = props.items.slice(start, start + SLASH_MENU_VISIBLE);
  return h(Box, { flexDirection: "column", marginTop: 1 },
    ...visible.map((item, index) => {
      const absolute = start + index;
      const active = absolute === props.selected;
      const marker = active ? `${theme.sym.select} ` : "  ";
      return h(Text, {
        key: item,
        color: active ? theme.accent : undefined,
        dimColor: !active,
        wrap: "truncate-end",
      }, `${marker}${item}`);
    }),
    h(Text, { dimColor: true },
      `(${props.selected + 1}/${props.items.length}) ↑↓ · Tab/Enter insert · Esc`));
}

/** Exported for unit tests. */
export function slashQuery(input: string): string | undefined {
  const match = /^\/(\S*)$/.exec(input);
  return match ? match[1] : undefined;
}

/** Exported for unit tests. */
export function collectSlashCommands(host: { listCommandEntries(): readonly SlashCommand[] }): readonly SlashCommand[] {
  const map = new Map<string, SlashCommand>();
  for (const command of BUILTIN_SLASH_COMMANDS) map.set(command.name, command);
  for (const command of host.listCommandEntries()) {
    map.set(command.name, {
      name: command.name,
      description: command.description.trim() || map.get(command.name)?.description || "",
    });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Exported for unit tests. Returns undefined when slash menu should be hidden. */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  query: string | undefined,
): readonly SlashCommand[] | undefined {
  if (query === undefined) return undefined;
  const needle = query.toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(needle));
}

function ConfirmView(props: Readonly<{
  confirm: NonNullable<ViewState["confirm"]>;
  rows: number;
}>): React.JSX.Element {
  const sourceLines = props.confirm.detail.split("\n");
  const allLines = sourceLines.length > 4_000
    ? [...sourceLines.slice(0, 3_999), "(diff truncated at 4000 lines)"]
    : sourceLines;
  // App chrome (~7) + question + border + Yes/No; +1 more when a scroll caption is needed.
  const baseReserve = 11;
  const provisional = Math.max(4, props.rows - baseReserve);
  const needsScroll = allLines.length > provisional;
  const visibleCount = Math.max(4, props.rows - baseReserve - (needsScroll ? 1 : 0));
  const maxScroll = Math.max(0, allLines.length - visibleCount);
  const scroll = Math.min(props.confirm.scroll, maxScroll);
  const visible = allLines.slice(scroll, scroll + visibleCount);
  const endLine = Math.min(scroll + visibleCount, allLines.length);
  return h(Box, { flexDirection: "column", flexGrow: 1 },
    h(Text, { bold: true }, props.confirm.question),
    h(Box, { flexDirection: "column", borderStyle: "single" },
      ...visible.map((line, index) => h(DiffLine, { key: `${scroll + index}-${line}`, line }))),
    maxScroll > 0
      ? h(Text, { dimColor: true }, `lines ${scroll + 1}–${endLine}/${allLines.length}`)
      : null,
    h(Text, { bold: true }, "Yes / No"));
}

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

function DiffLine({ line }: Readonly<{ line: string }>): React.JSX.Element {
  const color = line.startsWith("+") && !line.startsWith("+++")
    ? "green"
    : line.startsWith("-") && !line.startsWith("---") ? theme.error : undefined;
  return h(Text, { color, wrap: "truncate-end" }, line || " ");
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
  return { entries, statuses: {}, widgets: {}, bypass: false };
}
