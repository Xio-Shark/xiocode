/**
 * Chrome state of the TUI (statuses, tasklist, open questions) and the reducer that
 * maps bridge events onto it. Transcript content is reduced separately (transcript-log.ts).
 */

import type { SelectChoice } from "../runtime/interactive-io.ts";
import type { TuiEvent } from "./session-bridge.ts";
import type { ContextCompactionUiEvent } from "../runtime/types.ts";
import { t } from "../i18n/messages.ts";

export type SelectState = Readonly<{
  question: string;
  choices: readonly SelectChoice[];
  selected: number;
  /** Diff / command / call args under the question; present for every approval. */
  detail?: string;
  /** First visible detail line (PgUp/PgDn). */
  scroll: number;
  /** Action id of a confirmation, shown after the question. */
  scope?: string;
}>;

export type ViewState = Readonly<{
  statuses: Readonly<Record<string, string>>;
  /** Sticky panels keyed by widget id (e.g. tasklist). */
  widgets: Readonly<Record<string, readonly string[]>>;
  /**
   * Open choice list. Yes/no confirmations arrive here too (as allow/deny choices), so every
   * approval renders through one component; `detail` (diff, command, call args) marks those.
   */
  select?: SelectState;
  prompt?: Readonly<{ question: string; secret: boolean; value: string }>;
}>;

/** Chrome state (statuses, tasklist, open questions) from bridge events; exported for tests. */
export function reduceEvent(state: ViewState, event: TuiEvent): ViewState {
  if (event.kind === "confirm-open") {
    return openChoices(state, { question: event.question, choices: event.choices ?? confirmChoices(), detail: event.detail ?? "", scope: event.scope });
  }
  if (event.kind === "confirm-close") return { ...state, select: undefined };
  if (event.kind === "select-open") {
    promptDraftHolder = "";
    return openChoices(state, { question: event.question, choices: event.choices, detail: event.detail });
  }
  if (event.kind === "select-close") return { ...state, select: undefined };
  if (event.kind === "prompt-open") {
    promptDraftHolder = "";
    return {
      ...state,
      prompt: { question: event.question, secret: event.secret === true, value: "" },
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
  if (event.kind === "widget" && event.key === "tasklist") {
    const widgets = { ...state.widgets };
    if (event.lines && event.lines.length > 0) widgets.tasklist = event.lines;
    else delete widgets.tasklist;
    return { ...state, widgets };
  }
  // Transcript events (deltas, tools, notices, other widgets) belong to reduceScrollback.
  return state;
}

/** A yes/no confirmation as choices; "deny" is highlighted first so Enter never approves by accident. */
function confirmChoices(): readonly SelectChoice[] {
  return [
    { label: t("confirm.allow"), value: "once" },
    { label: t("confirm.deny"), value: "deny" },
  ];
}

function openChoices(
  state: ViewState,
  open: Readonly<{ question: string; choices: readonly SelectChoice[]; detail?: string; scope?: string }>,
): ViewState {
  const denyIndex = open.choices.findIndex((choice) => choice.value === "deny");
  const selected = open.detail !== undefined && denyIndex >= 0 ? denyIndex : 0;
  selectedValueHolder = open.choices[selected]?.value;
  openChoicesHolder = open.choices;
  return {
    ...state,
    select: { ...open, selected, scroll: 0 },
    prompt: undefined,
  };
}

/** Selected choice value mirrored for Enter handling without stale React closures. */
let selectedValueHolder: string | undefined;

let openChoicesHolder: readonly SelectChoice[] = [];

let promptDraftHolder = "";

export function takeSelectedValue(): string | undefined {
  return selectedValueHolder;
}

export function takeOpenChoices(): readonly SelectChoice[] {
  return openChoicesHolder;
}

export function takePromptDraft(): string {
  return promptDraftHolder;
}

export function setPromptDraftValue(value: string): void {
  promptDraftHolder = value;
}

/** Views mirror the highlighted choice here so Enter never reads a stale React closure. */
export function setSelectedValue(value: string | undefined): void {
  selectedValueHolder = value;
}

export function scrollChoiceDetail(state: ViewState, delta: number): ViewState {
  if (!state.select) return state;
  return { ...state, select: { ...state.select, scroll: Math.max(0, state.select.scroll + delta) } };
}

export function moveSelection(state: ViewState, delta: number): ViewState {
  if (!state.select) return state;
  const max = Math.max(0, state.select.choices.length - 1);
  const selected = Math.min(max, Math.max(0, state.select.selected + delta));
  selectedValueHolder = state.select.choices[selected]?.value;
  return { ...state, select: { ...state.select, selected } };
}

export function setPromptDraft(state: ViewState, value: string): ViewState {
  if (!state.prompt) return state;
  promptDraftHolder = value;
  return { ...state, prompt: { ...state.prompt, value } };
}

function reduceContextCompaction(
  state: ViewState,
  event: ContextCompactionUiEvent,
): ViewState {
  const statuses = { ...state.statuses };
  if (event.stage === "start") {
    statuses.context = t("context.compactingStatus");
    return { ...state, statuses };
  }
  // The start/success/skip/failure notice itself is projected by reduceScrollback.
  delete statuses.context;
  return { ...state, statuses };
}
