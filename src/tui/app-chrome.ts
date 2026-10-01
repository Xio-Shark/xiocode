/**
 * Fixed chrome around the transcript: the session header, the composer and the region
 * above it, and the choice / prompt views.
 */

import React, { memo } from "react";
import { Box, Text } from "ink";

import { truncateToDisplayWidth } from "./text-selection.ts";
import { type ComposerState } from "./composer.ts";
import { theme } from "./theme.ts";
import { BrandHeader } from "./shark-logo.ts";
import { t } from "../i18n/messages.ts";

import { type ViewState, setPromptDraftValue, setSelectedValue } from "./app-view-state.ts";

const h = React.createElement;

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
    borderColor: props.busy ? theme.muted : (props.active ? theme.accent : theme.muted),
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
    const prefixElement = h(Text, { color: props.busy ? theme.muted : theme.accent, bold: true }, prefix);
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
        ? h(Text, { color: theme.muted }, t("composer.placeholder"))
        : null);
  });

  const content = [
    ...rows,
    props.hint
      ? h(Text, { color: theme.muted }, `${theme.sym.nest} ${props.hint}`)
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
    borderColor: props.busy ? theme.muted : (text.length > 0 ? theme.accent : theme.muted),
    paddingX: 1,
  }, ...content);
});

/** Header chrome for the current turn: requesting → streaming → tool-use. */
export function busyPhaseLabel(input: Readonly<{
  busy: boolean;
  inFlightToolCount: number;
  inFlightSubagentCount?: number;
  liveKind?: "thinking" | "assistant";
}>): string | undefined {
  if (!input.busy) return undefined;
  if ((input.inFlightSubagentCount ?? 0) > 0) return t("phase.agents");
  if (input.inFlightToolCount > 0) return t("phase.tools");
  if (input.liveKind === "assistant" || input.liveKind === "thinking") return t("phase.streaming");
  return t("phase.working");
}

/** Prefix the header phase with the shared spinner frame (motion on + busy only). */
export function composePhaseChrome(
  label: string | undefined,
  spinnerFrame: string | undefined,
): string | undefined {
  if (label === undefined) return undefined;
  return spinnerFrame ? `${spinnerFrame} ${label}` : label;
}

export const SessionHeader = memo(function SessionHeader(props: Readonly<{
  version: string;
  model: string;
  thinking: string;
  plan?: string;
  busy?: boolean;
  /** Turn phase chrome: working… / streaming… / tools… / agents… */
  phase?: string;
  columns: number;
  compact?: boolean;
}>): React.JSX.Element {
  // Path / permission / usage / workspace live in the Claude-style footer;
  // header mirrors CondensedLogo: mascot + title / meta / cwd.
  const parts = [
    props.model,
    props.thinking,
    props.plan,
    props.phase ?? (props.busy ? t("phase.working") : undefined),
  ].filter((part): part is string => typeof part === "string" && part.length > 0);

  const meta = parts.length > 0 ? parts.join(` ${theme.sym.meta} `) : undefined;
  if (props.compact) {
    // The footer already shows the path; keep the working area for the transcript.
    return h(Text, { wrap: "truncate-end" },
      h(Text, { bold: true, color: theme.brand }, "XioCode"),
      h(Text, { color: theme.muted }, ` v${props.version}${meta ? ` ${theme.sym.meta} ${meta}` : ""}`));
  }
  // No path here: the footer shows it on every screen.
  return h(BrandHeader, {
    version: props.version,
    meta,
    columns: props.columns,
  });
});

export function SelectView(props: Readonly<{
  select: NonNullable<ViewState["select"]>;
  rows: number;
  columns: number;
}>): React.JSX.Element {
  setSelectedValue(props.select.choices[props.select.selected]?.value);
  const visibleCount = Math.max(4, props.rows - 5);
  const start = Math.min(
    Math.max(0, props.select.selected - visibleCount + 1),
    Math.max(0, props.select.choices.length - visibleCount),
  );
  const visible = props.select.choices.slice(start, start + visibleCount);
  // Every row must render as exactly one terminal line: Ink wraps by its own
  // width table, so an unclipped CJK/long label folds into a second row, the
  // frame grows past the terminal height, and Ink's incremental repaint starts
  // overwriting stale rows (visible as overlapping ghost text).
  const textBudget = Math.max(8, props.columns - 2);
  return h(Box, { flexDirection: "column", flexGrow: 1 },
    h(Text, { bold: true, wrap: "truncate-end" }, truncateToDisplayWidth(props.select.question, textBudget)),
    ...visible.map((choice, index) => {
      const active = start + index === props.select.selected;
      const marker = active ? `${theme.sym.select} ` : "  ";
      return h(Text, {
        key: `${choice.value}-${start + index}`,
        color: active ? theme.accent : theme.muted,
        wrap: "truncate-end",
      }, truncateToDisplayWidth(`${marker}${choice.label}`, textBudget));
    }),
    h(Text, { color: theme.muted, wrap: "truncate-end" },
      t("select.keys")));
}

export function PromptView(props: Readonly<{ prompt: NonNullable<ViewState["prompt"]> }>): React.JSX.Element {
  setPromptDraftValue(props.prompt.value);
  return h(Box, { flexDirection: "column", flexGrow: 1 },
    h(Text, { bold: true, wrap: "truncate-end" }, props.prompt.question),
    h(Text, { color: theme.muted }, props.prompt.secret
      ? t("prompt.secretKeys")
      : t("prompt.keys")));
}

export function maskPromptDisplay(prompt: NonNullable<ViewState["prompt"]>): string {
  if (!prompt.secret) return prompt.value;
  return "*".repeat([...prompt.value].length);
}
