/**
 * Interactive key map — the single source of truth behind `?` and `/help`.
 *
 * Every binding listed here must exist in `handleInput` (app.ts). This sheet is
 * the only place a user can discover the steer prefixes and the transcript
 * viewer, so a stale row here is a broken promise, not a cosmetic bug.
 */

import React from "react";
import { Box, Text } from "ink";

import { sliceViewerWindow } from "./composer.ts";
import { theme } from "./theme.ts";

const h = React.createElement;

export type Shortcut = Readonly<{ keys: string; description: string }>;
export type ShortcutGroup = Readonly<{ title: string; items: readonly Shortcut[] }>;

/**
 * Fullscreen (route A) owns its own transcript window, so it binds scroll keys.
 * Default interactive `xio` (route B) prints into the terminal buffer and leaves
 * scrollback to the terminal — advertising PgUp there would be a lie.
 */
export function shortcutGroups(
  options: Readonly<{ fullscreen: boolean }> = { fullscreen: false },
): readonly ShortcutGroup[] {
  const prompt: Shortcut[] = [
    { keys: "enter", description: "Send the prompt" },
    { keys: "shift+enter", description: "New line in the draft" },
    options.fullscreen
      ? { keys: "↑ ↓", description: "Scroll the transcript" }
      : { keys: "↑ ↓", description: "Walk prompt history (or draft lines)" },
    { keys: "ctrl+u ctrl+c", description: "Clear the draft" },
    { keys: "esc esc", description: "Clear the draft, keeping it in history" },
    { keys: "tab", description: "Cycle thinking level" },
    { keys: "shift+tab", description: "Cycle permission mode" },
  ];

  const running: Shortcut[] = [
    { keys: "esc", description: "Cancel the running task (draft is kept)" },
    { keys: "ctrl+c", description: "Cancel the running task" },
    { keys: "text", description: "Steer at the next tool/provider boundary" },
    { keys: "!text", description: "Steer now — abort the step, then continue" },
    { keys: ">>text", description: "Queue a follow-up for after the task ends" },
    { keys: "ctrl+x", description: "Drop the queued input" },
  ];

  const output: Shortcut[] = [
    { keys: "ctrl+o", description: "Open the last tool output in full" },
    { keys: "↑ ↓ pgup pgdn", description: "Scroll inside that overlay" },
    { keys: "ctrl+g ctrl+e", description: "Jump to its top / bottom" },
    { keys: "esc", description: "Close the overlay" },
  ];
  if (options.fullscreen) {
    output.push(
      { keys: "pgup pgdn", description: "Page through the transcript" },
      { keys: "drag", description: "Select with the mouse — copies on release" },
    );
  }

  return [
    { title: "Prompt", items: prompt },
    { title: "While a task runs", items: running },
    { title: "Output", items: output },
    {
      title: "Session",
      items: [
        { keys: "/", description: "Slash menu — ↑↓ move, tab complete, enter run" },
        { keys: "@", description: "Mention a file — tab/enter insert, esc dismiss" },
        { keys: "?", description: "This help" },
        { keys: "ctrl+c ctrl+c", description: "Exit from an empty prompt (so does /exit)" },
      ],
    },
  ];
}

export type ShortcutRow =
  | Readonly<{ kind: "title"; text: string }>
  | Readonly<{ kind: "item"; keys: string; description: string }>
  | Readonly<{ kind: "spacer" }>;

/** Flat, sliceable rows — one list shared by the overlay and the text renderer. */
export function shortcutRows(groups: readonly ShortcutGroup[]): readonly ShortcutRow[] {
  const rows: ShortcutRow[] = [];
  for (const group of groups) {
    if (rows.length > 0) rows.push({ kind: "spacer" });
    rows.push({ kind: "title", text: group.title });
    for (const item of group.items) {
      rows.push({ kind: "item", keys: item.keys, description: item.description });
    }
  }
  return rows;
}

/** Widest key column across every group, so all groups line up in one grid. */
export function shortcutKeyWidth(groups: readonly ShortcutGroup[]): number {
  let width = 0;
  for (const group of groups) {
    for (const item of group.items) width = Math.max(width, item.keys.length);
  }
  return width;
}

/** Plain-text rendering — used by tests and by any non-Ink surface. */
export function formatShortcutLines(groups: readonly ShortcutGroup[]): readonly string[] {
  const width = shortcutKeyWidth(groups);
  return shortcutRows(groups).map((row) => {
    if (row.kind === "spacer") return "";
    if (row.kind === "title") return row.text;
    return `  ${row.keys.padEnd(width)}  ${row.description}`;
  });
}

/**
 * Contextual hint under the composer — the one line that changes with state.
 * Returns undefined when the footer already says everything worth saying.
 */
export function composerHint(state: Readonly<{
  busy: boolean;
  /** Keystroke waiting on its second press, if any. */
  armed?: "clear-draft" | "exit";
  queued: boolean;
  canSteer: boolean;
}>): string | undefined {
  // An armed key is a question already on screen — answer it before anything else.
  if (state.armed === "exit") return "ctrl+c again to exit";
  if (state.armed === "clear-draft") return "esc again to clear the draft";
  if (state.busy) {
    const parts = ["esc cancel"];
    if (state.canSteer) parts.push("type to steer", "!now", ">>after");
    if (state.queued) parts.push("ctrl+x drop queued");
    return parts.join(` ${theme.sym.meta} `);
  }
  if (state.queued) return `enter to send queued ${theme.sym.meta} ctrl+x to drop it`;
  return undefined;
}

/**
 * Rows the sheet can show at this terminal height. Fullscreen pins the root box
 * to `rows`, so overflowing here makes Ink collapse lines on top of each other —
 * the reserve covers header (4), this box's own chrome (8), composer (5), footer (2).
 */
export function shortcutViewport(rows: number): number {
  return Math.max(4, rows - 19);
}

/** Scrollable overlay for `?` and `/help`. */
export function ShortcutsOverlay(props: Readonly<{
  groups: readonly ShortcutGroup[];
  rows: number;
  scrollOffset: number;
  /** Slash commands currently registered, shown as a pointer to the `/` menu. */
  commandCount?: number;
}>): React.JSX.Element {
  const width = shortcutKeyWidth(props.groups);
  const all = shortcutRows(props.groups);
  const window = sliceViewerWindow(
    all.map((_, index) => String(index)),
    shortcutViewport(props.rows),
    props.scrollOffset,
  );
  const visible = all.slice(window.offset, window.offset + window.visible.length);
  const commands = typeof props.commandCount === "number" && props.commandCount > 0
    ? `Type / for ${props.commandCount} commands ${theme.sym.meta} @ to mention files`
    : `Type / for commands ${theme.sym.meta} @ to mention files`;
  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    borderColor: "gray",
    paddingX: 1,
    marginY: 1,
  },
    h(Text, { bold: true }, `${theme.sym.brand} Shortcuts`),
    ...visible.map((row, index) => {
      const key = `row-${window.offset + index}`;
      if (row.kind === "spacer") return h(Text, { key }, " ");
      if (row.kind === "title") {
        return h(Text, { key, color: theme.accent, bold: true }, row.text);
      }
      return h(Text, { key, wrap: "truncate-end" },
        h(Text, { color: theme.brand }, `  ${row.keys.padEnd(width)}`),
        h(Text, { dimColor: true }, `  ${row.description}`));
    }),
    h(Text, null, " "),
    h(Text, { dimColor: true }, commands),
    h(Text, { dimColor: true }, window.indicator
      ? `${window.indicator} ${theme.sym.meta} ↑↓ scroll ${theme.sym.meta} esc close`
      : "esc close"));
}
