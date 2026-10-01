/**
 * Keyboard input routing for the App: which interaction owns a key, the composer and
 * overlay bindings, and running a submitted line (slash command or prompt).
 */

import { isMouseLeakChunk } from "./mouse-scroll.ts";
import { expandFileMentions } from "./file-mention.ts";
import { isContextCompactionError } from "../runtime/context-compaction.ts";
import type { PreparedSession } from "../runtime/session.ts";
import type { SelectChoice } from "../runtime/interactive-io.ts";
import type { TuiSessionBridge } from "./session-bridge.ts";
import {
  applyInputChunk,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  deleteWordForward,
  historyDown,
  historySearch,
  historyUp,
  killToCursor,
  moveCursor,
  moveCursorLine,
  moveCursorTo,
  moveCursorWord,
  type ComposerState,
} from "./composer.ts";
import { type HistoryBlock } from "./transcript-log.ts";
import { t } from "../i18n/messages.ts";

import { collectSlashCommands, type SlashCommand } from "./overlays.ts";
import { type SearchState } from "./app-transcript.ts";
import {
  setPromptDraftValue,
  takeOpenChoices,
  takePromptDraft,
  takeSelectedValue,
} from "./app-view-state.ts";

export function interactionMode(bridge: TuiSessionBridge): "confirm" | "select" | "prompt" | "none" {
  if (bridge.confirmPending) return "confirm";
  if (bridge.selectPending) return "select";
  if (bridge.promptPending) return "prompt";
  return "none";
}

export function handleInput(options: Readonly<{
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
  /** Close the slash menu for the current draft text. */
  dismissSlash: () => void;
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
  /** Esc / Ctrl+C arm state for the composer hint. */
  escArmed: "clear-draft" | "exit" | "rewind" | undefined;
  /** Ctrl+C layering: cancel turn → clear draft → arm exit → exit. */
  pressCtrlC: () => "cancelled" | "cleared" | "armed" | "exit";
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
  /** Rewind picker (Esc Esc on an empty prompt). */
  rewindPickerOpen?: () => boolean;
  rewindPickerMove?: (delta: number) => void;
  rewindPickerEnter?: () => void;
  rewindPickerBack?: () => void;
}>): void {
  if (options.interaction === "confirm" || options.interaction === "select") {
    const confirm = options.interaction === "confirm";
    handleChoiceInput({
      ...options,
      choices: takeOpenChoices(),
      scrollDetail: options.scrollConfirm,
      answer: (value) => confirm
        ? options.bridge.answerConfirmation(value === "once")
        : options.bridge.answerSelect(value),
    });
    return;
  }
  if (options.interaction === "prompt") {
    handlePromptInput(options);
    return;
  }
  if (options.key.ctrl && options.character === "c") {
    if (options.pressCtrlC() === "exit") void options.close(0);
    return;
  }
  // Rewind picker (Esc Esc on an empty prompt): owns navigation while open.
  if (options.rewindPickerOpen?.()) {
    if (options.key.escape) options.rewindPickerBack?.();
    else if (options.key.return) options.rewindPickerEnter?.();
    else if (options.key.upArrow) options.rewindPickerMove?.(-1);
    else if (options.key.downArrow) options.rewindPickerMove?.(1);
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
  // Ctrl+P opens/dismisses unified slash commands menu; Ctrl+T model switch
  if (options.key.ctrl && options.character === "p") {
    if (!options.busy) {
      if (options.slashItems !== undefined) {
        options.dismissSlash();
      } else {
        options.setInputValue("/");
      }
    }
    return;
  }
  // `?` opens the sheet only from an empty prompt; inside a draft it is text ("why?").
  if (options.character === "?" && !options.key.ctrl && !options.key.meta && options.composer.text.length === 0) {
    options.toggleShortcuts?.();
    return;
  }
  if (options.key.ctrl && options.character === "t" && !options.busy) {
    void options.submit("/model");
    return;
  }
  // Ctrl+R: Reverse prompt history search (standard shell/readline convention)
  if (options.key.ctrl && options.character === "r" && !options.busy) {
    options.setComposerState(historySearch(options.composer));
    return;
  }
  // Alt+Z: Fold / unfold the block at the top of the current view
  if (options.key.meta && options.character === "z") {
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
  // An open slash menu is the innermost layer: Esc closes it for this draft
  // (the text stays; typing reopens it) before Esc means "clear the draft".
  if (options.key.escape && !options.busy && options.slashItems !== undefined) {
    options.dismissSlash();
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
  // line/half-page chords open the in-app review overlay (first press
  // scrolls it too). Fullscreen already binds the same keys to its window.
  if (options.appendScrollback) {
    const halfPage = Math.max(4, Math.floor(options.rows / 2));
    let step = 0;
    if (options.key.pageUp) step = 20;
    else if (options.key.pageDown) step = -20;
    else if (options.key.ctrl && options.character === "j") step = 1;
    else if (options.key.ctrl && options.character === "k") step = -1;
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
    // Ctrl+J/K line scroll, Ctrl+D half-page. (Ctrl+U is exclusively readline killToCursor).
    if (options.key.ctrl && options.character === "j") {
      options.scrollTranscript(1);
      return;
    }
    if (options.key.ctrl && options.character === "k") {
      options.scrollTranscript(-1);
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

export async function runInput(session: PreparedSession, value: string, bridge: TuiSessionBridge): Promise<void> {
  try {
    if (value === "/help") {
      const names = collectSlashCommands(session.host).map((command) => `/${command.name}`).join(" ");
      bridge.sink.notify?.(
        t("notice.help", { names }),
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
            ? t("notice.bypassFull")
            : t("notice.bypassAuto"),
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

/**
 * Keys for an open choice list. Esc always declines (a confirmation answers false, a
 * picker answers nothing); y / n pick allow-once / deny where the list offers them.
 */
function handleChoiceInput(options: Readonly<{
  character: string;
  key: Readonly<{ escape?: boolean; return: boolean; upArrow?: boolean; downArrow?: boolean; pageUp?: boolean; pageDown?: boolean }>;
  choices: readonly SelectChoice[];
  answer: (value: string | undefined) => void;
  moveSelect: (delta: number) => void;
  scrollDetail: (delta: number) => void;
}>): void {
  const letter = options.character.trim().toLowerCase();
  const offers = (value: string) => options.choices.some((choice) => choice.value === value);
  if (options.key.escape || letter === "q") return options.answer(undefined);
  if (letter === "y" && offers("once")) return options.answer("once");
  if (letter === "n" && offers("deny")) return options.answer("deny");
  if (options.key.upArrow) return options.moveSelect(-1);
  if (options.key.downArrow) return options.moveSelect(1);
  if (options.key.pageUp) return options.scrollDetail(-10);
  if (options.key.pageDown) return options.scrollDetail(10);
  // The highlighted value is mirrored outside React state so Enter never reads a stale closure.
  if (options.key.return) options.answer(takeSelectedValue());
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

function formatResult(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}
