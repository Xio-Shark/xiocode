/**
 * Interactive key map — the single source of truth behind `?` and `/help`.
 *
 * Every binding listed here must exist in `handleInput` (app.ts).
 *
 * Keymap Conflict Resolution Matrix (T09):
 * ┌──────────────┬──────────────────┬─────────────────────────────┬──────────────────────────────────────────┐
 * │ Key          │ State            │ Action                      │ Semantic / Rule                          │
 * ├──────────────┼──────────────────┼─────────────────────────────┼──────────────────────────────────────────┤
 * │ Ctrl+C       │ busy             │ Cancel running task         │ abort turn immediately                   │
 * │ Ctrl+C       │ idle (any text)  │ Arm exit / exit             │ double press to exit; NEVER clears draft │
 * │ Esc          │ overlay open     │ Close current overlay       │ dismiss innermost overlay first          │
 * │ Esc          │ menu open        │ Dismiss menu                │ keeps typed draft intact                 │
 * │ Esc          │ busy             │ Cancel running task         │ keeps typed draft intact                 │
 * │ Esc Esc      │ idle (has draft) │ Clear draft                 │ double press clears draft into history   │
 * │ Esc Esc      │ idle (empty)     │ Rewind picker               │ double press opens turn rewind picker    │
 * │ Tab          │ menu open        │ Accept completion           │ tab inserts completion candidate         │
 * │ Tab          │ idle (no menu)   │ No-op                       │ thinking level moved to /thinking        │
 * │ Shift+Tab    │ idle             │ Cycle permission mode       │ auto → full → strict                     │
 * │ Ctrl+R       │ idle             │ Reverse history search      │ shell-standard reverse prompt search     │
 * │ Alt+Z        │ idle / review    │ Fold/unfold top block       │ replacement for previous Ctrl+R binding  │
 * │ Ctrl+U       │ idle             │ Kill draft to cursor        │ standard readline; NEVER scrolls page    │
 * │ Ctrl+D       │ idle / review    │ Scroll half page down       │ unambiguous half-page scroll             │
 * │ Ctrl+P / /   │ idle             │ Command palette / slash menu│ unified fuzzy search for slash commands  │
 * └──────────────┴──────────────────┴─────────────────────────────┴──────────────────────────────────────────┘
 */

import React from "react";
import { Box, Text } from "ink";

import { sliceViewerWindow } from "./composer.ts";
import { t } from "../i18n/messages.ts";
import { theme } from "./theme.ts";

const h = React.createElement;

export type Shortcut = Readonly<{ keys: string; description: string }>;
export type ShortcutGroup = Readonly<{ title: string; items: readonly Shortcut[] }>;

/**
 * Fullscreen (route A, the default for interactive `xio`) owns its transcript window,
 * so it binds scroll keys. `XIO_TUI_FULLSCREEN=0` (route B) prints into the terminal
 * buffer and leaves scrollback to the terminal; there PgUp opens the review overlay.
 */
export function shortcutGroups(
  options: Readonly<{ fullscreen: boolean }> = { fullscreen: false },
): readonly ShortcutGroup[] {
  const prompt: Shortcut[] = [
    { keys: "enter", description: t("shortcuts.send") },
    { keys: "shift+enter", description: t("shortcuts.newline") },
    options.fullscreen
      ? { keys: "↑ ↓", description: t("shortcuts.scrollTranscript") }
      : { keys: "↑ ↓", description: t("shortcuts.history") },
    { keys: "home end ctrl+a ctrl+e", description: t("shortcuts.draftEnds") },
    { keys: "alt+←→ alt+b/f", description: t("shortcuts.word") },
    { keys: "alt+backspace alt+d", description: t("shortcuts.deleteWord") },
    { keys: "ctrl+u", description: t("shortcuts.kill") },
    { keys: "esc esc", description: t("shortcuts.escEsc") },
    { keys: "tab", description: t("shortcuts.tab") },
    { keys: "shift+tab", description: t("shortcuts.cyclePermission") },
    { keys: "ctrl+r", description: t("shortcuts.searchHistory") },
  ];

  const running: Shortcut[] = [
    { keys: "esc", description: t("shortcuts.cancelKeep") },
    { keys: "ctrl+c", description: t("shortcuts.cancel") },
    { keys: "text", description: t("shortcuts.steer") },
    { keys: "!text", description: t("shortcuts.steerNow") },
    { keys: ">>text", description: t("shortcuts.queue") },
    { keys: "ctrl+x", description: t("shortcuts.dropQueued") },
  ];

  const find: Shortcut[] = [
    { keys: "ctrl+f", description: t("shortcuts.search") },
    { keys: "alt+z", description: t("shortcuts.fold") },
    { keys: "ctrl+p", description: t("shortcuts.palette") },
    { keys: "ctrl+t", description: t("shortcuts.model") },
    { keys: "esc", description: t("shortcuts.closeSearch") },
  ];

  const output: Shortcut[] = [
    { keys: "ctrl+o", description: t("shortcuts.openOutput") },
    { keys: "↑ ↓ pgup pgdn", description: t("shortcuts.scrollOverlay") },
    { keys: "ctrl+g ctrl+e", description: t("shortcuts.overlayEnds") },
    { keys: "y", description: t("shortcuts.copy") },
    { keys: "esc", description: t("shortcuts.closeOverlay") },
  ];
  if (options.fullscreen) {
    output.push(
      { keys: "pgup pgdn", description: t("shortcuts.page") },
      { keys: "ctrl+j k", description: t("shortcuts.line") },
      { keys: "ctrl+d", description: t("shortcuts.half") },
      { keys: "drag", description: t("shortcuts.drag") },
    );
  } else {
    output.push(
      { keys: "pgup pgdn", description: t("shortcuts.review") },
      { keys: "ctrl+j k", description: t("shortcuts.reviewLine") },
      { keys: "ctrl+d", description: t("shortcuts.reviewHalf") },
    );
  }

  return [
    { title: t("shortcuts.groupPrompt"), items: prompt },
    { title: t("shortcuts.groupRunning"), items: running },
    { title: t("shortcuts.groupOutput"), items: output },
    { title: t("shortcuts.groupFind"), items: find },
    {
      title: t("shortcuts.groupSession"),
      items: [
        { keys: "/", description: t("shortcuts.slash") },
        { keys: "@", description: t("shortcuts.mention") },
        { keys: "?", description: t("shortcuts.help") },
        { keys: "ctrl+c ctrl+c", description: t("shortcuts.exit") },
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
  armed?: "clear-draft" | "exit" | "rewind";
  queued: boolean;
  canSteer: boolean;
}>): string | undefined {
  // An armed key is a question already on screen — answer it before anything else.
  if (state.armed === "exit") return t("hint.ctrlcExit");
  if (state.armed === "clear-draft") return t("hint.escClear");
  if (state.armed === "rewind") return t("hint.escRewind");
  if (state.busy) {
    const parts = [t("hint.escCancel")];
    if (state.canSteer) parts.push(t("hint.steer"), t("hint.steerNow"), t("hint.after"));
    if (state.queued) parts.push(t("hint.dropQueued"));
    return parts.join(` ${theme.sym.meta} `);
  }
  if (state.queued) return t("hint.sendQueued");
  return undefined;
}

import { computeShortcutViewport } from "./chrome-metrics.ts";

/**
 * Rows the sheet can show at this terminal height. Fullscreen pins the root box
 * to `rows`, so overflowing here makes Ink collapse lines on top of each other —
 * the reserve covers header (5), this box's own chrome (8), composer (4), footer (2).
 */
export function shortcutViewport(rows: number): number {
  return computeShortcutViewport(rows);
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
    ? t("shortcuts.commandsCount", { count: props.commandCount })
    : t("shortcuts.commands");
  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    borderColor: theme.muted,
    paddingX: 1,
    marginY: 1,
  },
    h(Text, { bold: true }, `${theme.sym.brand} ${t("shortcuts.title")}`),
    ...visible.map((row, index) => {
      const key = `row-${window.offset + index}`;
      if (row.kind === "spacer") return h(Text, { key }, " ");
      if (row.kind === "title") {
        return h(Text, { key, color: theme.accent, bold: true }, row.text);
      }
      return h(Text, { key, wrap: "truncate-end" },
        h(Text, { color: theme.brand }, `  ${row.keys.padEnd(width)}`),
        h(Text, { color: theme.muted }, `  ${row.description}`));
    }),
    h(Text, null, " "),
    h(Text, { color: theme.muted }, commands),
    h(Text, { color: theme.muted }, window.indicator
      ? t("shortcuts.scrollClose", { indicator: window.indicator })
      : t("common.escClose")));
}
