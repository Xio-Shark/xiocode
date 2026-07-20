/**
 * Dedicated composer state: cursor, grapheme-safe edit, multiline paste,
 * history, and busy-turn UI draft queue.
 *
 * **Composer `queue` vs runtime follow-up (do not conflate):**
 * - `ComposerState.queue` — UI-only draft buffer when the session lacks `steer`
 *   (fallback). Restored into the draft after idle for the user to edit/submit.
 * - `session.followUp()` — runtime mailbox consumed automatically at natural end
 *   of the agent run (no tool calls + soft steer empty). Prefer `>>text` while
 *   busy in the TUI, or call `followUp` explicitly.
 * - Soft/hard `session.steer()` — adjusts the *current* turn at provider-safe
 *   boundaries; not deferred-to-idle user work.
 */

export type ComposerState = Readonly<{
  /** Full draft text (may contain newlines). */
  text: string;
  /** Cursor offset in UTF-16 code units (JS string index), clamped to [0, text.length]. */
  cursor: number;
  /** Older → newer completed prompts (newest last). */
  history: readonly string[];
  /** Index into history while navigating; -1 means draft mode. */
  historyIndex: number;
  /** Snapshot of draft before history navigation begins. */
  draftBeforeHistory: string;
  /**
   * Input queued while a turn is busy. Visible, editable, removable.
   * UI draft only — executed when the user submits it after the turn ends
   * (or via explicit flush). Not the same as `session.followUp()`.
   */
  queue: string | undefined;
}>;

export function emptyComposer(): ComposerState {
  return {
    text: "",
    cursor: 0,
    history: [],
    historyIndex: -1,
    draftBeforeHistory: "",
    queue: undefined,
  };
}

export function setComposerText(state: ComposerState, text: string, cursor = text.length): ComposerState {
  const nextCursor = clamp(cursor, 0, text.length);
  return { ...state, text, cursor: nextCursor, historyIndex: -1 };
}

export function insertAtCursor(state: ComposerState, chunk: string): ComposerState {
  if (chunk.length === 0) return state;
  const text = state.text.slice(0, state.cursor) + chunk + state.text.slice(state.cursor);
  return {
    ...state,
    text,
    cursor: state.cursor + chunk.length,
    historyIndex: -1,
  };
}

/** Delete one grapheme cluster left of the cursor. */
export function deleteBackward(state: ComposerState): ComposerState {
  if (state.cursor <= 0) return state;
  const before = state.text.slice(0, state.cursor);
  const graphemes = [...before];
  if (graphemes.length === 0) return state;
  graphemes.pop();
  const nextBefore = graphemes.join("");
  const text = nextBefore + state.text.slice(state.cursor);
  return { ...state, text, cursor: nextBefore.length, historyIndex: -1 };
}

/** Delete one grapheme cluster right of the cursor. */
export function deleteForward(state: ComposerState): ComposerState {
  if (state.cursor >= state.text.length) return state;
  const after = state.text.slice(state.cursor);
  const graphemes = [...after];
  if (graphemes.length === 0) return state;
  graphemes.shift();
  const text = state.text.slice(0, state.cursor) + graphemes.join("");
  return { ...state, text, cursor: state.cursor, historyIndex: -1 };
}

export function moveCursor(state: ComposerState, delta: number): ComposerState {
  return { ...state, cursor: clamp(state.cursor + delta, 0, state.text.length) };
}

export function moveCursorTo(state: ComposerState, position: number): ComposerState {
  return { ...state, cursor: clamp(position, 0, state.text.length) };
}

export function moveCursorLine(state: ComposerState, direction: -1 | 1): ComposerState {
  const lines = state.text.split("\n");
  let offset = 0;
  let row = 0;
  let col = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lineEnd = offset + line.length;
    if (state.cursor <= lineEnd) {
      row = i;
      col = state.cursor - offset;
      break;
    }
    offset = lineEnd + 1; // +1 for newline
    if (i === lines.length - 1) {
      row = i;
      col = line.length;
    }
  }
  const nextRow = clamp(row + direction, 0, lines.length - 1);
  if (nextRow === row) {
    // Stay on same row: home/end of line.
    if (direction < 0) return moveCursorTo(state, offset);
    return moveCursorTo(state, offset + lines[row]!.length);
  }
  let nextOffset = 0;
  for (let i = 0; i < nextRow; i += 1) {
    nextOffset += lines[i]!.length + 1;
  }
  const nextCol = Math.min(col, lines[nextRow]!.length);
  return moveCursorTo(state, nextOffset + nextCol);
}

/**
 * Apply an input chunk that may contain newlines (bracketed paste).
 * Returns the updated composer and whether Enter should submit (only when the
 * chunk is a lone return with no trailing paste body, or explicit submit).
 *
 * Multiline paste: insert the full chunk including newlines; never submit partial.
 */
export function applyInputChunk(
  state: ComposerState,
  character: string,
  key: Readonly<{ return: boolean; shift?: boolean }>,
): Readonly<{ state: ComposerState; submit: boolean }> {
  if (character.length > 1) {
    const normalized = character.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Ink often delivers a whole line as "text\r". That is submit, not multiline paste.
    if (normalized.endsWith("\n") && !normalized.slice(0, -1).includes("\n")) {
      const body = normalized.slice(0, -1);
      return { state: insertAtCursor(state, body), submit: true };
    }
    // True multiline / bracketed paste: insert full body, never drop the suffix.
    return { state: insertAtCursor(state, normalized), submit: false };
  }
  // Lone newline character without key.return (some paste paths).
  if (character.length === 1 && /[\r\n]/.test(character) && !key.return) {
    return { state: insertAtCursor(state, "\n"), submit: false };
  }
  if (key.return) {
    if (key.shift) {
      return { state: insertAtCursor(state, "\n"), submit: false };
    }
    return { state, submit: true };
  }
  if (character.length > 0 && !/[\r\n]/.test(character)) {
    return { state: insertAtCursor(state, character), submit: false };
  }
  return { state, submit: false };
}

export function rememberSubmission(state: ComposerState, value: string): ComposerState {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ...state, text: "", cursor: 0, historyIndex: -1, draftBeforeHistory: "" };
  }
  const history = [...state.history];
  if (history.at(-1) !== trimmed) history.push(trimmed);
  // Cap history length.
  const capped = history.length > 100 ? history.slice(-100) : history;
  return {
    ...state,
    text: "",
    cursor: 0,
    history: capped,
    historyIndex: -1,
    draftBeforeHistory: "",
  };
}

export function historyUp(state: ComposerState): ComposerState {
  if (state.history.length === 0) return state;
  if (state.historyIndex === -1) {
    const index = state.history.length - 1;
    return {
      ...state,
      draftBeforeHistory: state.text,
      historyIndex: index,
      text: state.history[index]!,
      cursor: state.history[index]!.length,
    };
  }
  if (state.historyIndex <= 0) return state;
  const index = state.historyIndex - 1;
  return {
    ...state,
    historyIndex: index,
    text: state.history[index]!,
    cursor: state.history[index]!.length,
  };
}

export function historyDown(state: ComposerState): ComposerState {
  if (state.historyIndex === -1) return state;
  if (state.historyIndex >= state.history.length - 1) {
    return {
      ...state,
      historyIndex: -1,
      text: state.draftBeforeHistory,
      cursor: state.draftBeforeHistory.length,
      draftBeforeHistory: "",
    };
  }
  const index = state.historyIndex + 1;
  return {
    ...state,
    historyIndex: index,
    text: state.history[index]!,
    cursor: state.history[index]!.length,
  };
}

export function queueWhileBusy(state: ComposerState, value: string): ComposerState {
  const trimmed = value.trim();
  if (trimmed.length === 0) return state;
  return {
    ...state,
    text: "",
    cursor: 0,
    queue: trimmed,
    historyIndex: -1,
  };
}

/**
 * Classify busy-turn submit text for the TUI.
 * - `>>…` → runtime follow-up (after natural end)
 * - `!…` → hard steer
 * - otherwise → soft steer
 */
export type BusySubmitIntent =
  | Readonly<{ kind: "follow_up"; text: string }>
  | Readonly<{ kind: "hard"; text: string }>
  | Readonly<{ kind: "soft"; text: string }>;

export function parseBusySubmitIntent(raw: string): BusySubmitIntent | undefined {
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value.startsWith(">>")) {
    const text = value.slice(2).trim();
    return text.length > 0 ? { kind: "follow_up", text } : undefined;
  }
  if (value.startsWith("!")) {
    const text = value.slice(1).trim();
    return text.length > 0 ? { kind: "hard", text } : undefined;
  }
  return { kind: "soft", text: value };
}

export function clearQueue(state: ComposerState): ComposerState {
  return { ...state, queue: undefined };
}

/** Move queued text back into the draft for edit/remove/submit. */
export function loadQueueIntoDraft(state: ComposerState): ComposerState {
  if (!state.queue) return state;
  return {
    ...state,
    text: state.queue,
    cursor: state.queue.length,
    queue: undefined,
  };
}

/** Display string with a block cursor marker for tests / simple renders. */
export function formatComposerDisplay(state: ComposerState): string {
  const before = state.text.slice(0, state.cursor);
  const after = state.text.slice(state.cursor);
  return `${before}█${after}`;
}

/** Slice lines for a scrollable viewer overlay (pi-style in-app scroll). */
export function sliceViewerWindow(
  lines: readonly string[],
  viewport: number,
  offset: number,
): Readonly<{
  visible: readonly string[];
  offset: number;
  maxOffset: number;
  total: number;
  indicator: string | undefined;
}> {
  const size = Math.max(1, Math.floor(viewport));
  const total = lines.length;
  const maxOffset = Math.max(0, total - size);
  const clamped = Math.max(0, Math.min(Math.floor(offset), maxOffset));
  const visible = lines.slice(clamped, clamped + size);
  const indicator = total > size
    ? `lines ${clamped + 1}–${clamped + visible.length}/${total}`
    : undefined;
  return { visible, offset: clamped, maxOffset, total, indicator };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
