import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";

import type { PreparedSession } from "../runtime/session.ts";
import type { TuiEvent, TuiSessionBridge } from "./session-bridge.ts";
import type { ChatMessage } from "../runtime/types.ts";

const h = React.createElement;

type TranscriptEntry = Readonly<{
  id: number;
  kind: "user" | "assistant" | "tool" | "notice" | "command";
  text: string;
  error?: boolean;
}>;

type ViewState = Readonly<{
  entries: readonly TranscriptEntry[];
  statuses: Readonly<Record<string, string>>;
  confirm?: Readonly<{ question: string; detail: string; scroll: number }>;
  bypass: boolean;
}>;

export type AppProps = Readonly<{
  session: PreparedSession;
  bridge: TuiSessionBridge;
  cwd: string;
  onExit: (code: number) => Promise<void>;
}>;

export function App(props: AppProps): React.JSX.Element {
  const { rows } = useWindowSize();
  const [view, setView] = useState<ViewState>(() => createInitialView(props.session.getMessages()));
  useEffect(() => props.bridge.subscribe((event) => setView((current) => reduceEvent(current, event))), [props.bridge]);
  const { input, busy } = useSessionInteraction(props, setView);

  const visibleEntries = useMemo(() => view.entries.slice(-Math.max(4, rows - 6)), [rows, view.entries]);
  return h(Box, { flexDirection: "column", height: rows },
    view.confirm
      ? h(ConfirmView, { confirm: view.confirm, rows })
      : h(Box, { flexDirection: "column", flexGrow: 1 },
        ...visibleEntries.map((entry) => h(TranscriptRow, { key: entry.id, entry }))),
    h(Box, { borderStyle: "single", paddingX: 1 },
      h(Text, { color: busy ? "gray" : "cyan" }, busy ? "working" : ">"),
      h(Text, null, ` ${input}`)),
    h(StatusBar, { model: props.session.model.id, busy, cwd: props.cwd, statuses: view.statuses }));
}

function useSessionInteraction(
  props: AppProps,
  setView: React.Dispatch<React.SetStateAction<ViewState>>,
): Readonly<{ input: string; busy: boolean }> {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const inputRef = useRef("");
  const [busy, setBusy] = useState(false);
  const setInputValue = (value: string) => {
    inputRef.current = value;
    setInput(value);
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
    setBusy(true);
    try {
      await runInput(props.session, value, props.bridge);
    } finally {
      setBusy(false);
    }
  };
  useInput((character, key) => handleInput({
    character,
    key,
    input: inputRef.current,
    busy,
    confirmOpen: props.bridge.confirmPending,
    setInputValue,
    submit,
    close,
    session: props.session,
    bridge: props.bridge,
    scrollConfirm: (delta) => setView((current) => scrollConfirmation(current, delta)),
  }));
  return { input, busy };
}

function handleInput(options: Readonly<{
  character: string;
  key: Readonly<{ ctrl: boolean; meta: boolean; return: boolean; backspace: boolean; delete: boolean }>;
  input: string;
  busy: boolean;
  setInputValue: (value: string) => void;
  submit: (value?: string) => Promise<void>;
  close: (code: number) => Promise<void>;
  session: PreparedSession;
  bridge: TuiSessionBridge;
  confirmOpen: boolean;
  scrollConfirm: (delta: number) => void;
}>): void {
  if (options.confirmOpen) {
    handleConfirmInput(options);
    return;
  }
  if (options.key.ctrl && options.character === "c") {
    if (options.busy) options.session.abortTurn();
    else void options.close(0);
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
      bridge.sink.notify?.("Commands: /help /status /merge /rollback /rollback turn /bypass /sandbox /exit", "info");
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
    bridge.sink.notify?.(error instanceof Error ? error.message : String(error), "error");
  }
}

function reduceEvent(state: ViewState, event: TuiEvent): ViewState {
  if (event.kind === "confirm-open") {
    return { ...state, confirm: { question: event.question, detail: event.detail ?? "", scroll: 0 } };
  }
  if (event.kind === "confirm-close") return { ...state, confirm: undefined };
  if (event.kind === "bypass") return { ...state, bypass: event.enabled };
  if (event.kind === "status") {
    const statuses = { ...state.statuses };
    if (event.text) statuses[event.key] = event.text;
    else delete statuses[event.key];
    return { ...state, statuses };
  }
  if (event.kind === "widget") {
    return event.lines ? appendEntry(state, "notice", event.lines.join("\n")) : state;
  }
  if (event.kind === "assistant-delta") return appendAssistantDelta(state, event.text);
  if (event.kind === "assistant-text") return finalizeAssistant(state, event.text);
  if (event.kind === "tool-start") return appendEntry(state, "tool", `${event.name} ${event.detail}`);
  if (event.kind === "tool-end") return appendEntry(state, "tool", `${event.name} ${event.error ? "failed" : "done"}`, event.error);
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

function scrollConfirmation(state: ViewState, delta: number): ViewState {
  if (!state.confirm) return state;
  return { ...state, confirm: { ...state.confirm, scroll: Math.max(0, state.confirm.scroll + delta) } };
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

function appendEntry(state: ViewState, kind: TranscriptEntry["kind"], text: string, error = false): ViewState {
  return { ...state, entries: [...state.entries, { id: nextEntryId(), kind, text, error }] };
}

let entryId = 0;
function nextEntryId(): number {
  entryId += 1;
  return entryId;
}

function TranscriptRow({ entry }: Readonly<{ entry: TranscriptEntry }>): React.JSX.Element {
  const prefix = entry.kind === "user" ? ">" : entry.kind === "assistant" ? "xio" : entry.kind === "tool" ? "tool" : "-";
  const color = entry.error ? "red" : entry.kind === "assistant" ? "green" : entry.kind === "tool" ? "yellow" : undefined;
  return h(Box, null, h(Text, { color, bold: entry.kind === "user" }, `${prefix} `), h(Text, { color, wrap: "wrap" }, entry.text));
}

function StatusBar(props: Readonly<{
  model: string;
  busy: boolean;
  cwd: string;
  statuses: Readonly<Record<string, string>>;
}>): React.JSX.Element {
  const extra = Object.values(props.statuses).join(" | ");
  const text = [props.model, props.busy ? "busy" : "idle", props.cwd, extra].filter(Boolean).join(" | ");
  return h(Box, { paddingX: 1 }, h(Text, { inverse: true, wrap: "truncate-end" }, ` ${text} `));
}

function ConfirmView(props: Readonly<{
  confirm: NonNullable<ViewState["confirm"]>;
  rows: number;
}>): React.JSX.Element {
  const sourceLines = props.confirm.detail.split("\n");
  const allLines = sourceLines.length > 4_000
    ? [...sourceLines.slice(0, 3_999), "(diff truncated at 4000 lines)"]
    : sourceLines;
  const visibleCount = Math.max(4, props.rows - 7);
  const maxScroll = Math.max(0, allLines.length - visibleCount);
  const scroll = Math.min(props.confirm.scroll, maxScroll);
  const visible = allLines.slice(scroll, scroll + visibleCount);
  return h(Box, { flexDirection: "column", flexGrow: 1 },
    h(Text, { bold: true }, props.confirm.question),
    h(Box, { flexDirection: "column", borderStyle: "single", flexGrow: 1 },
      ...visible.map((line, index) => h(DiffLine, { key: `${scroll + index}-${line}`, line }))),
    h(Text, { bold: true }, "Yes / No"));
}

function DiffLine({ line }: Readonly<{ line: string }>): React.JSX.Element {
  const color = line.startsWith("+") && !line.startsWith("+++")
    ? "green"
    : line.startsWith("-") && !line.startsWith("---") ? "red" : undefined;
  return h(Text, { color, wrap: "truncate-end" }, line || " ");
}

function formatResult(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

function createInitialView(messages: readonly ChatMessage[]): ViewState {
  const entries = messages.flatMap((message): TranscriptEntry[] => {
    if (message.role === "system") return [];
    const kind = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "tool";
    return [{ id: nextEntryId(), kind, text: message.content }];
  });
  return { entries, statuses: {}, bypass: false };
}
