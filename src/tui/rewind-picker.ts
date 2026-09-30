/**
 * Esc Esc on an empty prompt: pick a turn, then what to bring back.
 *
 * Pure state + one overlay component; app.ts only wires keys to these
 * reducers and runs the chosen rewind through the session.
 */

import React from "react";
import { Box, Text } from "ink";

import type { RewindMode, RewindPointView } from "../runtime/rewind.ts";
import { theme } from "./theme.ts";

const h = React.createElement;
const VISIBLE_POINTS = 8;

export type RewindPickerState = Readonly<{
  /** Newest first. */
  points: readonly RewindPointView[];
  index: number;
  stage: "point" | "mode";
  modeIndex: number;
}>;

export type RewindModeOption = Readonly<{
  mode: RewindMode;
  label: string;
  /** Why this option cannot run for the selected point. */
  unavailable?: string;
}>;

export function openRewindPicker(points: readonly RewindPointView[]): RewindPickerState {
  return { points: [...points].reverse(), index: 0, stage: "point", modeIndex: 0 };
}

export function rewindModeOptions(point: RewindPointView): RewindModeOption[] {
  const code = point.code.available ? undefined : point.code.reason;
  const conversation = point.conversation.available ? undefined : point.conversation.reason;
  return [
    { mode: "both", label: "Restore files and conversation", ...optional(code ?? conversation) },
    { mode: "conversation", label: "Restore conversation only", ...optional(conversation) },
    { mode: "code", label: "Restore files only", ...optional(code) },
  ];
}

export function moveRewindPicker(state: RewindPickerState, delta: number): RewindPickerState {
  if (state.stage === "mode") {
    const count = rewindModeOptions(state.points[state.index]!).length;
    return { ...state, modeIndex: (state.modeIndex + delta + count) % count };
  }
  const count = state.points.length;
  return count === 0 ? state : { ...state, index: (state.index + delta + count) % count };
}

/**
 * Enter: a point opens its options (preselecting the first that can run);
 * an option that can run is returned for execution.
 */
export function enterRewindPicker(
  state: RewindPickerState,
): Readonly<{ state: RewindPickerState } | { run: Readonly<{ index: number; mode: RewindMode }> }> {
  const point = state.points[state.index];
  if (!point) return { state };
  const options = rewindModeOptions(point);
  if (state.stage === "point") {
    const firstRunnable = options.findIndex((option) => option.unavailable === undefined);
    return { state: { ...state, stage: "mode", modeIndex: Math.max(0, firstRunnable) } };
  }
  const option = options[state.modeIndex];
  if (!option || option.unavailable !== undefined) return { state };
  return { run: { index: point.index, mode: option.mode } };
}

/** Esc: options → list → closed (undefined). */
export function backRewindPicker(state: RewindPickerState): RewindPickerState | undefined {
  return state.stage === "mode" ? { ...state, stage: "point" } : undefined;
}

export function RewindPickerOverlay(props: Readonly<{ state: RewindPickerState }>): React.JSX.Element {
  const { state } = props;
  if (state.points.length === 0) {
    return h(Box, { flexDirection: "column", marginBottom: 1 },
      h(Text, { color: theme.accent, bold: true }, "Rewind"),
      h(Text, { dimColor: true }, "Nothing to rewind to yet: a point is recorded when a turn starts · esc close"));
  }
  const point = state.points[state.index]!;
  if (state.stage === "mode") {
    const options = rewindModeOptions(point);
    return h(Box, { flexDirection: "column", marginBottom: 1 },
      h(Text, { color: theme.accent, bold: true, wrap: "truncate-end" }, `Rewind to before: ${point.prompt}`),
      ...options.map((option, i) => {
        const active = i === state.modeIndex;
        const marker = active ? `${theme.sym.select} ` : "  ";
        const suffix = option.unavailable ? ` — ${option.unavailable}` : "";
        return h(Text, {
          key: option.mode,
          color: active && !option.unavailable ? theme.accent : undefined,
          bold: active,
          dimColor: option.unavailable !== undefined || !active,
          wrap: "truncate-end",
        }, `${marker}${option.label}${suffix}`);
      }),
      h(Text, { dimColor: true }, "↑↓ · Enter · esc back"));
  }
  const start = Math.min(
    Math.max(0, state.index - VISIBLE_POINTS + 1),
    Math.max(0, state.points.length - VISIBLE_POINTS),
  );
  const visible = state.points.slice(start, start + VISIBLE_POINTS);
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, { color: theme.accent, bold: true }, "Rewind to the start of a turn"),
    ...visible.map((item, i) => {
      const active = start + i === state.index;
      const marker = active ? `${theme.sym.select} ` : "  ";
      const what = [
        item.code.available ? "files" : undefined,
        item.conversation.available ? "chat" : undefined,
      ].filter(Boolean).join("+") || "—";
      return h(Text, {
        key: item.index,
        color: active ? theme.accent : undefined,
        bold: active,
        dimColor: !active,
        wrap: "truncate-end",
      }, `${marker}${String(item.index).padStart(2)}. ${item.prompt}  (${what})`);
    }),
    h(Text, { dimColor: true },
      `(${state.index + 1}/${state.points.length}) ↑↓ · Enter choose what to restore · esc close`));
}

function optional(reason: string | undefined): Readonly<{ unavailable?: string }> {
  return reason === undefined ? {} : { unavailable: reason };
}
