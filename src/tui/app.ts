import { createRequire } from "node:module";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";

import { TOOL_OUTPUT_PREVIEW_LINES, previewText } from "../runtime/session-ui.ts";
import { CONTEXT_SUMMARY_NAME, isContextCompactionError } from "../runtime/context-compaction.ts";
import { SESSION_RECOVERY_NAME } from "../runtime/session-recovery.ts";
import type { PreparedSession } from "../runtime/session.ts";
import type { SelectChoice } from "../runtime/interactive-io.ts";
import type { TuiEvent, TuiSessionBridge } from "./session-bridge.ts";
import type { ChatMessage, ContextCompactionUiEvent } from "../runtime/types.ts";
import { collapseNoticesForDisplay, formatShortCwd, padSlashName, theme } from "./theme.ts";

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
  const [view, setView] = useState<ViewState>(() => createInitialView(props.session.getMessages()));
  useEffect(() => props.bridge.subscribe((event) => setView((current) => reduceEvent(current, event))), [props.bridge]);
  const { input, busy, slashIndex, setSlashIndex } = useSessionInteraction(props, setView);

  const slashItems = useMemo(
    () => filterSlashCommands(collectSlashCommands(props.session.host), slashQuery(input)),
    [props.session.host, input],
  );
  const slashOpen = !busy && slashItems !== undefined;
  const safeSlashIndex = slashOpen && slashItems.length > 0
    ? Math.min(slashIndex, slashItems.length - 1)
    : 0;

  const tasklist = view.widgets.tasklist;
  // TasklistPanel: content (≤10) + marginTop(1) + border top/bottom (2)
  const tasklistRows = tasklist && tasklist.length > 0 ? Math.min(tasklist.length, 10) + 3 : 0;
  const chromeRows = (slashOpen ? 5 + Math.min(SLASH_MENU_VISIBLE, slashItems?.length ?? 0) + 1 : 5)
    + tasklistRows;
  const visibleEntries = useMemo(
    () => collapseNoticesForDisplay(view.entries).slice(-Math.max(4, rows - chromeRows)),
    [rows, view.entries, chromeRows],
  );
  const modelLabel = view.statuses.model ?? `${props.session.getModel().provider}/${props.session.getModel().id}`;
  const thinkingLabel = view.statuses.thinking ?? `think:${props.session.getThinkingLevel()}`;
  const permissionLabel = view.statuses.permission
    ?? `perm:${props.session.getPermissionMode()}`;
  const planLabel = view.statuses.plan;
  return h(Box, { flexDirection: "column", height: rows },
    h(SessionHeader, {
      version: PACKAGE_VERSION,
      model: modelLabel,
      thinking: thinkingLabel,
      permission: permissionLabel,
      plan: planLabel,
      cwd: props.cwd,
      context: view.statuses.context,
      busy,
    }),
    view.confirm
      ? h(ConfirmView, { confirm: view.confirm, rows })
      : view.select
        ? h(SelectView, { select: view.select, rows })
        : view.prompt
          ? h(PromptView, { prompt: view.prompt })
          : h(Box, { flexDirection: "column", flexGrow: 1 },
            ...visibleEntries.map((entry) => h(TranscriptRow, { key: entry.id, entry }))),
    tasklist && tasklist.length > 0
      ? h(TasklistPanel, { lines: tasklist.slice(0, 10) })
      : null,
    h(Box, { marginTop: 1 },
      h(Text, { dimColor: busy }, busy ? theme.sym.busy : theme.sym.prompt),
      h(Text, null, ` ${view.prompt ? maskPromptDisplay(view.prompt) : input}`)),
    slashOpen
      ? h(SlashMenu, { items: slashItems ?? [], selected: safeSlashIndex })
      : null,
    h(FooterHints, {
      bypass: view.bypass || Boolean(view.statuses.bypass),
    }));
}

function useSessionInteraction(
  props: AppProps,
  setView: React.Dispatch<React.SetStateAction<ViewState>>,
): Readonly<{
  input: string;
  busy: boolean;
  slashIndex: number;
  setSlashIndex: React.Dispatch<React.SetStateAction<number>>;
}> {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const inputRef = useRef("");
  const [busy, setBusy] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashIndexRef = useRef(0);
  const setInputValue = (value: string) => {
    inputRef.current = value;
    setInput(value);
    setSlashIndex(0);
    slashIndexRef.current = 0;
  };
  const moveSlash = (delta: number) => {
    setSlashIndex((current) => {
      const items = filterSlashCommands(collectSlashCommands(props.session.host), slashQuery(inputRef.current));
      if (!items || items.length === 0) return 0;
      const next = (current + delta + items.length) % items.length;
      slashIndexRef.current = next;
      return next;
    });
  };
  const close = async (code: number) => {
    await props.onExit(code);
    exit(code);
  };
  const submit = async (rawValue = inputRef.current) => {
    const value = rawValue.trim();
    if (value.length === 0 || busy) return;
    setInputValue("");
    setView((current) => appendEntry(current, value.startsWith("/") ? "command" : "user", value));
    if (value === "/exit" || value === "/quit") {
      await close(0);
      return;
    }
    const startedAt = Date.now();
    const isPrompt = !value.startsWith("/");
    setBusy(true);
    try {
      await runInput(props.session, value, props.bridge);
    } finally {
      setBusy(false);
      if (isPrompt) {
        const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        setView((current) => appendEntry(current, "notice", `* Done in ${seconds}s`));
      }
    }
  };
  useInput((character, key) => handleInput({
    character,
    key,
    input: inputRef.current,
    busy,
    interaction: interactionMode(props.bridge),
    slashIndex: slashIndexRef.current,
    slashItems: filterSlashCommands(collectSlashCommands(props.session.host), slashQuery(inputRef.current)),
    setInputValue,
    moveSlash,
    submit,
    close,
    session: props.session,
    bridge: props.bridge,
    scrollConfirm: (delta) => setView((current) => scrollConfirmation(current, delta)),
    moveSelect: (delta) => setView((current) => moveSelection(current, delta)),
    setPromptValue: (value) => setView((current) => setPromptDraft(current, value)),
    toggleExpandable: () => setView((current) => toggleLatestExpandable(current)),
  }));
  return { input, busy, slashIndex, setSlashIndex };
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
    upArrow?: boolean;
    downArrow?: boolean;
    pageUp?: boolean;
    pageDown?: boolean;
    tab?: boolean;
  }>;
  input: string;
  busy: boolean;
  setInputValue: (value: string) => void;
  moveSlash: (delta: number) => void;
  submit: (value?: string) => Promise<void>;
  close: (code: number) => Promise<void>;
  session: PreparedSession;
  bridge: TuiSessionBridge;
  interaction: "confirm" | "select" | "prompt" | "none";
  slashIndex: number;
  slashItems: readonly SlashCommand[] | undefined;
  scrollConfirm: (delta: number) => void;
  moveSelect: (delta: number) => void;
  setPromptValue: (value: string) => void;
  toggleExpandable: () => void;
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
      void options.submit(picked ? `/${picked.name}` : options.input);
      return;
    }
  }

  if (options.key.tab && !options.busy) {
    void options.session.cycleThinkingLevel();
    return;
  }
  const newline = options.character.search(/[\r\n]/);
  if (options.key.return || newline >= 0) {
    const value = newline >= 0 ? options.input + options.character.slice(0, newline) : options.input;
    void options.submit(value);
    return;
  }
  if (options.key.backspace || options.key.delete) {
    options.setInputValue([...options.input].slice(0, -1).join(""));
    return;
  }
  if (options.key.ctrl && options.character === "u") {
    options.setInputValue("");
    return;
  }
  if (!options.key.ctrl && !options.key.meta && options.character.length > 0) {
    options.setInputValue(options.input + options.character);
  }
}

async function runInput(session: PreparedSession, value: string, bridge: TuiSessionBridge): Promise<void> {
  try {
    if (value === "/help") {
      const names = collectSlashCommands(session.host).map((command) => `/${command.name}`).join(" ");
      bridge.sink.notify?.(
        `Commands: ${names} · Shift+Tab 权限 · Tab 思考 · Ctrl+O 展开`,
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
    await session.runPrompt(value);
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
    return {
      ...state,
      entries: [...state.entries, {
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
  return appendEntry(state, "notice", event.text, event.level === "error");
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
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index]!;
    if (entry.kind !== "tool" || (entry.output ?? "") !== "") continue;
    // Prefer tool_call id when present so parallel same-name tools pair correctly.
    if (event.callId) {
      if (entry.callId !== event.callId) continue;
    } else if (entry.title !== event.name) {
      continue;
    }
    const next = [...state.entries];
    const output = event.output;
    const lineCount = output.length === 0 ? 0 : output.split("\n").length;
    next[index] = {
      ...entry,
      text: event.error ? "failed" : "done",
      error: event.error,
      output,
      previewCollapsed: lineCount > TOOL_OUTPUT_PREVIEW_LINES,
      ...(event.callId ? { callId: event.callId } : {}),
    };
    return { ...state, entries: next };
  }
  return {
    ...state,
    entries: [...state.entries, {
      id: nextEntryId(),
      kind: "tool" as const,
      text: event.error ? "failed" : "done",
      error: event.error,
      title: event.name,
      detail: "",
      output: event.output,
      previewCollapsed: event.output.split("\n").length > TOOL_OUTPUT_PREVIEW_LINES,
      ...(event.callId ? { callId: event.callId } : {}),
    }],
  };
}

/** Exported for unit tests of Ctrl+O expand/collapse. */
export function toggleLatestExpandable(state: ViewState): ViewState {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index]!;
    if (entry.kind === "thinking" && entry.text.length > 0) {
      const next = [...state.entries];
      next[index] = { ...entry, collapsed: !entry.collapsed };
      return { ...state, entries: next };
    }
    if (entry.kind === "tool" && (entry.output?.length ?? 0) > 0) {
      const lineCount = entry.output!.split("\n").length;
      // Short outputs are already fully visible — keep scanning for an older expandable.
      if (lineCount <= TOOL_OUTPUT_PREVIEW_LINES) continue;
      const next = [...state.entries];
      next[index] = { ...entry, previewCollapsed: !entry.previewCollapsed };
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
    const label = thoughtLabel(entry);
    if (entry.collapsed) {
      return h(Box, { marginY: 0 }, h(Text, { dimColor: true }, label));
    }
    return h(Box, { flexDirection: "column", marginBottom: 0 },
      h(Text, { dimColor: true }, label),
      h(Text, { dimColor: true, wrap: "wrap" }, entry.text));
  }
  if (entry.kind === "tool") {
    const title = entry.title ?? "tool";
    const detail = entry.detail ? ` ${entry.detail}` : "";
    const status = entry.text ? ` ${entry.text}` : "";
    const output = entry.output ?? "";
    const body = output.length === 0
      ? undefined
      : entry.previewCollapsed === false
        ? output
        : previewText(output).text;
    return h(Box, { flexDirection: "column", marginY: 0 },
      h(Text, {
        color: entry.error ? theme.error : theme.tool,
        dimColor: !entry.error,
        wrap: "wrap",
      }, `${theme.sym.tool} ${title}${detail}${status}`),
      body
        ? h(Text, {
          color: entry.error ? theme.error : undefined,
          dimColor: true,
          wrap: "wrap",
        }, body)
        : null,
      entry.previewCollapsed === true && output.split("\n").length > TOOL_OUTPUT_PREVIEW_LINES
        ? h(Text, { dimColor: true }, "Ctrl+O expand")
        : null);
  }
  if (entry.kind === "user" || entry.kind === "command") {
    const bar = theme.userBar;
    return h(Box, { width: "100%", backgroundColor: bar, paddingX: 1, marginBottom: 1 },
      h(Text, { backgroundColor: bar }, `${theme.sym.prompt} `),
      h(Text, { backgroundColor: bar, wrap: "wrap" }, entry.text));
  }
  if (entry.kind === "assistant") {
    return h(Box, { marginBottom: 1 },
      h(Text, null, `${theme.sym.answer} `),
      h(Text, { wrap: "wrap" }, entry.text));
  }
  if (entry.text.startsWith("* ")) {
    return h(Text, { dimColor: true }, entry.text);
  }
  const color = entry.error ? theme.error : undefined;
  return h(Box, null,
    h(Text, { color, dimColor: !entry.error }, `${theme.sym.meta} `),
    h(Text, { color, dimColor: !entry.error, wrap: "wrap" }, entry.text));
}

function thoughtLabel(entry: TranscriptEntry): string {
  if (entry.collapsed) {
    const seconds = entry.thoughtSeconds;
    return typeof seconds === "number" && seconds > 0
      ? `Thought for ${seconds}s`
      : "Thought";
  }
  return "Thinking…";
}

function SessionHeader(props: Readonly<{
  version: string;
  model: string;
  thinking: string;
  permission: string;
  plan?: string;
  cwd: string;
  context?: string;
  busy?: boolean;
}>): React.JSX.Element {
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, null,
      h(Text, { color: theme.brand, bold: true }, `${theme.sym.brand} `),
      h(Text, { bold: true }, `XioCode v${props.version}`)),
    h(Text, { dimColor: true, wrap: "truncate-end" },
      [
        props.model,
        props.thinking,
        props.permission,
        props.plan,
        props.busy ? "working…" : undefined,
        props.context,
        formatShortCwd(props.cwd),
      ].filter(Boolean).join(" · ")));
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

/** Footer is hints (+ bypass) only — model/think/cwd/perm live in the header (D2). */
function FooterHints(props: Readonly<{ bypass: boolean }>): React.JSX.Element {
  return h(Box, { flexDirection: "column", marginTop: 1 },
    h(Text, { dimColor: true },
      props.bypass
        ? "▶▶ bypass on · Shift+Tab 权限 · Tab 思考 · Ctrl+O · Ctrl+C"
        : "Shift+Tab 权限 · Tab 思考 · Ctrl+O · Ctrl+C"));
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
