import type { InteractiveIO, PromptOptions, SelectChoice } from "../runtime/interactive-io.ts";
import { toolCallDetail, toolResultOutput } from "../runtime/session-ui.ts";
import type { SessionUiSink } from "../runtime/session-ui.ts";
import type { ContextCompactionUiEvent } from "../runtime/types.ts";

export type TuiEvent =
  | Readonly<{ kind: "assistant-delta"; text: string }>
  | Readonly<{ kind: "assistant-text"; text: string }>
  | Readonly<{ kind: "thinking-delta"; text: string }>
  | Readonly<{ kind: "tool-start"; name: string; detail: string; callId?: string }>
  | Readonly<{ kind: "tool-end"; name: string; error: boolean; output: string; callId?: string }>
  | Readonly<{ kind: "context-compaction"; event: ContextCompactionUiEvent }>
  | Readonly<{ kind: "notice"; text: string; level?: string }>
  | Readonly<{ kind: "status"; key: string; text?: string }>
  | Readonly<{ kind: "widget"; key: string; lines?: readonly string[] }>
  | Readonly<{ kind: "confirm-open"; question: string; detail?: string }>
  | Readonly<{ kind: "confirm-close" }>
  | Readonly<{ kind: "select-open"; question: string; choices: readonly SelectChoice[] }>
  | Readonly<{ kind: "select-close" }>
  | Readonly<{ kind: "prompt-open"; question: string; secret?: boolean; placeholder?: string }>
  | Readonly<{ kind: "prompt-close" }>
  | Readonly<{ kind: "bypass"; enabled: boolean }>;

export class TuiSessionBridge implements InteractiveIO {
  readonly #listeners = new Set<(event: TuiEvent) => void>();
  #lastNotice: string | undefined;
  #pendingAnswer: ((approved: boolean) => void) | undefined;
  #pendingSelect: ((value: string | undefined) => void) | undefined;
  #pendingPrompt: ((value: string | undefined) => void) | undefined;
  #bypass = false;

  readonly sink: SessionUiSink = {
    notify: (message, level) => {
      this.#lastNotice = message;
      this.emit({ kind: "notice", text: message, level });
    },
    setStatus: (key, text) => this.emit({ kind: "status", key, text }),
    setWidget: (key, content) => this.emit({ kind: "widget", key, lines: content }),
    onAssistantDelta: (text) => this.emit({ kind: "assistant-delta", text }),
    onAssistantText: (text) => this.emit({ kind: "assistant-text", text }),
    onThinkingDelta: (text) => this.emit({ kind: "thinking-delta", text }),
    onToolStart: (call) => this.emit({
      kind: "tool-start",
      name: call.name,
      detail: toolCallDetail(call),
      callId: call.id,
    }),
    onToolEnd: (call, result) => this.emit({
      kind: "tool-end",
      name: call.name,
      error: result.isError === true,
      output: toolResultOutput(result),
      callId: call.id,
    }),
    onContextCompaction: (event) => this.emit({ kind: "context-compaction", event }),
    onCancelled: () => this.emit({ kind: "notice", text: "Turn cancelled.", level: "warning" }),
    onDoneContract: (summary) => this.emit({ kind: "notice", text: summary, level: "warning" }),
  };

  readonly ask = async (question: string): Promise<boolean> => {
    if (this.#bypass) {
      this.sink.notify?.(`Bypass auto-approved: ${question}`, "warning");
      return true;
    }
    this.assertIdle();
    this.emit({ kind: "confirm-open", question, detail: this.#lastNotice });
    return new Promise<boolean>((resolve) => {
      this.#pendingAnswer = resolve;
    });
  };

  readonly select = async (question: string, choices: readonly SelectChoice[]): Promise<string | undefined> => {
    this.assertIdle();
    this.emit({ kind: "select-open", question, choices });
    return new Promise<string | undefined>((resolve) => {
      this.#pendingSelect = resolve;
    });
  };

  readonly prompt = async (question: string, options: PromptOptions = {}): Promise<string | undefined> => {
    this.assertIdle();
    this.emit({
      kind: "prompt-open",
      question,
      secret: options.secret === true,
      placeholder: options.placeholder,
    });
    return new Promise<string | undefined>((resolve) => {
      this.#pendingPrompt = resolve;
    });
  };

  subscribe(listener: (event: TuiEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  answerConfirmation(approved: boolean): void {
    const resolve = this.#pendingAnswer;
    if (!resolve) return;
    this.#pendingAnswer = undefined;
    this.emit({ kind: "confirm-close" });
    resolve(approved);
  }

  answerSelect(value: string | undefined): void {
    const resolve = this.#pendingSelect;
    if (!resolve) return;
    this.#pendingSelect = undefined;
    this.emit({ kind: "select-close" });
    resolve(value);
  }

  answerPrompt(value: string | undefined): void {
    const resolve = this.#pendingPrompt;
    if (!resolve) return;
    this.#pendingPrompt = undefined;
    this.emit({ kind: "prompt-close" });
    resolve(value);
  }

  toggleBypass(): boolean {
    this.#bypass = !this.#bypass;
    this.emit({ kind: "bypass", enabled: this.#bypass });
    this.emit({ kind: "status", key: "bypass", text: this.#bypass ? "BYPASS" : undefined });
    this.sink.notify?.(`Bypass ${this.#bypass ? "enabled" : "disabled"} for this session.`, "warning");
    return this.#bypass;
  }

  get bypass(): boolean {
    return this.#bypass;
  }

  get confirmPending(): boolean {
    return this.#pendingAnswer !== undefined;
  }

  get selectPending(): boolean {
    return this.#pendingSelect !== undefined;
  }

  get promptPending(): boolean {
    return this.#pendingPrompt !== undefined;
  }

  get interactionPending(): boolean {
    return this.confirmPending || this.selectPending || this.promptPending;
  }

  private assertIdle(): void {
    if (this.interactionPending) {
      throw new Error("a TUI interaction is already pending");
    }
  }

  private emit(event: TuiEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
