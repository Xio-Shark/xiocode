/**
 * The App's interaction state hook: composer, menus, overlays, search, review, scroll and
 * the handlers that tie key presses to them.
 */

import React, { useEffect, useRef, useState } from "react";
import { useApp, useInput } from "ink";

import {
  scrollOffsetForLine,
  searchTranscriptLines,
  transcriptFlatLines,
} from "./transcript-search.ts";
import { fuzzyFilter } from "./fuzzy.ts";

import { copyTextToClipboard } from "./clipboard.ts";
import { attachMouseScrollListener, stripMouseLeak } from "./mouse-scroll.ts";
import { atQuery, filterFiles, insertFileMention, listWorkspaceFiles } from "./file-mention.ts";
import { cellFromMouse, selectionDragDistance, type TextSelectionRange } from "./text-selection.ts";
import {
  clearQueue,
  emptyComposer,
  loadQueueIntoDraft,
  parseBusySubmitIntent,
  queueWhileBusy,
  rememberSubmission,
  setComposerText,
  type ComposerState,
} from "./composer.ts";
import {
  adjacentExpandableHistoryBlock,
  appendUserBlock,
  latestExpandableToolBlock,
  reduceScrollback,
  type HistoryBlock,
  type ScrollbackState,
} from "./transcript-log.ts";
import {
  backRewindPicker,
  enterRewindPicker,
  moveRewindPicker,
  openRewindPicker,
  type RewindPickerState,
} from "./rewind-picker.ts";
import type { RewindMode } from "../runtime/rewind.ts";
import { t } from "../i18n/messages.ts";

import {
  collectSlashCommands,
  filterSlashCommands,
  slashQuery,
  viewerScrollBounds,
} from "./overlays.ts";
import { handleInput, interactionMode, runInput } from "./app-input.ts";
import { type SearchState, blockFullText } from "./app-transcript.ts";
import {
  type ViewState,
  moveSelection,
  reduceEvent,
  scrollChoiceDetail,
  setPromptDraft,
} from "./app-view-state.ts";
import { type AppProps, DOUBLE_CLICK_MS, type LineTarget } from "./app.ts";

export function useSessionInteraction(
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
  slashDismissed: string | undefined;
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
  /** Esc Esc on an empty prompt: rewind picker. */
  rewindPicker: RewindPickerState | undefined;
  /** Esc layering: cancel turn / double-press clear draft. */
  pressEsc: () => boolean;
  escArmed: "clear-draft" | "exit" | "rewind" | undefined;
  pressCtrlC: () => "cancelled" | "cleared" | "armed" | "exit";
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
  const [rewindPicker, setRewindPicker] = useState<RewindPickerState | undefined>(undefined);
  const rewindPickerRef = useRef(rewindPicker);
  rewindPickerRef.current = rewindPicker;
  const [escArmed, setEscArmed] = useState<"clear-draft" | "exit" | "rewind" | undefined>(undefined);
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
      // Empty prompt: Esc Esc opens the rewind picker (not right after a cancel,
      // so mashing Esc to stop a turn does not also open it).
      if (Date.now() - lastCancelAtRef.current < 1_000) {
        setEscArmed(undefined);
        return true;
      }
      if (escArmedRef.current === "rewind") {
        setEscArmed(undefined);
        setRewindPicker(openRewindPicker(props.session.rewind.list()));
        return true;
      }
      setEscArmed("rewind");
      if (escTimerRef.current) clearTimeout(escTimerRef.current);
      escTimerRef.current = setTimeout(() => setEscArmed(undefined), 800);
      return true;
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
  /**
   * Ctrl+C layering: a running turn is cancelled; while idle, a double-press
   * within 1.5s exits. Ctrl+C never clears draft (draft clearing is exclusive to Esc Esc).
   */
  const pressCtrlC = (): "cancelled" | "cleared" | "armed" | "exit" => {
    if (busyRef.current) {
      lastCancelAtRef.current = Date.now();
      props.session.abortTurn();
      return "cancelled";
    }
    if (escArmedRef.current === "exit") return "exit";
    setEscArmed("exit");
    if (escTimerRef.current) clearTimeout(escTimerRef.current);
    escTimerRef.current = setTimeout(() => setEscArmed(undefined), 1_500);
    return "armed";
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
  /** Draft text for which the slash menu was closed with Esc. */
  const [slashDismissed, setSlashDismissed] = useState<string | undefined>(undefined);
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
        const notice = t("notice.followUp", { text: intent.text.slice(0, 80) });
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
          ? t("notice.hardSteer", { text: intent.text.slice(0, 80) })
          : t("notice.softSteer", { text: intent.text.slice(0, 80) });
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
      const notice = t("notice.queuedNext", { text: value.slice(0, 80) });
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
        const done = t("notice.done", { seconds });
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
    dismissSlash: () => setSlashDismissed(composerRef.current.text),
    setInputValue,
    setComposerState,
    moveSlash,
    submit,
    close,
    session: props.session,
    bridge: props.bridge,
    scrollConfirm: (delta) => setView((current) => scrollChoiceDetail(current, delta)),
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
    ...rewindPickerHandlers,
    pressEsc,
    pressCtrlC,
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
      if (block?.output) {
        setTranscriptViewer(block);
      } else {
        props.bridge.sink.notify?.(t("notice.nothingToExpand"), "info");
      }
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
        ? t("notice.copied", { via: result.via.join(", ") })
        : t("notice.copyFailed"),
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
  const runRewind = (index: number, mode: RewindMode) => {
    setRewindPicker(undefined);
    void (async () => {
      try {
        const outcome = await props.session.rewind.run(index, mode);
        props.bridge.sink.notify?.(outcome.summary, "info");
        if (outcome.prompt !== undefined) {
          setComposerState(setComposerText(composerRef.current, outcome.prompt, outcome.prompt.length));
        }
      } catch (error) {
        props.bridge.sink.notify?.(error instanceof Error ? error.message : String(error), "error");
      }
    })();
  };
  const rewindPickerHandlers = {
    rewindPickerOpen: () => rewindPickerRef.current !== undefined,
    rewindPickerMove: (delta: number) => setRewindPicker((current) => (current ? moveRewindPicker(current, delta) : current)),
    rewindPickerEnter: () => {
      const current = rewindPickerRef.current;
      if (!current) return;
      const next = enterRewindPicker(current);
      if ("run" in next) runRewind(next.run.index, next.run.mode);
      else setRewindPicker(next.state);
    },
    rewindPickerBack: () => setRewindPicker((current) => (current ? backRewindPicker(current) : current)),
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
    slashDismissed,
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
    pressCtrlC,
    escArmed,
    rewindPicker,
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
