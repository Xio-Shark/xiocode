import type { SessionUiSink } from "../runtime/session-ui.ts";

export type TuiEvent =
  | Readonly<{ kind: "assistant-delta"; text: string }>
  | Readonly<{ kind: "assistant-text"; text: string }>
  | Readonly<{ kind: "tool-start"; name: string; detail: string }>
  | Readonly<{ kind: "tool-end"; name: string; error: boolean }>
  | Readonly<{ kind: "notice"; text: string; level?: string }>
  | Readonly<{ kind: "status"; key: string; text?: string }>
  | Readonly<{ kind: "widget"; key: string; lines?: readonly string[] }>
  | Readonly<{ kind: "confirm-open"; question: string; detail?: string }>
  | Readonly<{ kind: "confirm-close" }>
  | Readonly<{ kind: "bypass"; enabled: boolean }>;

export class TuiSessionBridge {
  readonly #listeners = new Set<(event: TuiEvent) => void>();
  #lastNotice: string | undefined;
  #pendingAnswer: ((approved: boolean) => void) | undefined;
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
    onToolStart: (call) => this.emit({
      kind: "tool-start",
      name: call.name,
      detail: JSON.stringify(call.arguments),
    }),
    onToolEnd: (call, result) => this.emit({ kind: "tool-end", name: call.name, error: result.isError === true }),
    onCancelled: () => this.emit({ kind: "notice", text: "Turn cancelled.", level: "warning" }),
    onDoneContract: (summary) => this.emit({ kind: "notice", text: summary, level: "warning" }),
  };

  readonly ask = async (question: string): Promise<boolean> => {
    if (this.#bypass) {
      this.sink.notify?.(`Bypass auto-approved: ${question}`, "warning");
      return true;
    }
    if (this.#pendingAnswer) {
      throw new Error("a TUI confirmation is already pending");
    }
    this.emit({ kind: "confirm-open", question, detail: this.#lastNotice });
    return new Promise<boolean>((resolve) => {
      this.#pendingAnswer = resolve;
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

  private emit(event: TuiEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
