import type { InteractiveIO, PromptOptions, SelectChoice } from "../runtime/interactive-io.ts";
import {
  formatToolOutputForDisplay,
  toolCallDetail,
  toolResultOutput,
} from "../runtime/session-ui.ts";
import type { SessionUiSink } from "../runtime/session-ui.ts";
import type { SubagentUiBridge } from "../runtime/explore/subagent-ui.ts";
import type { ContextCompactionUiEvent } from "../runtime/types.ts";

export type ConfirmationRequest = Readonly<{
  kind?: "tool" | "merge" | "rollback" | "generic";
  question: string;
  detail?: string;
  actionId?: string;
  scopes?: readonly ("once" | "session")[];
}>;

export type TuiEvent =
  | Readonly<{ kind: "assistant-delta"; text: string }>
  | Readonly<{ kind: "assistant-text"; text: string }>
  | Readonly<{ kind: "thinking-delta"; text: string }>
  | Readonly<{ kind: "tool-start"; name: string; detail: string; callId?: string }>
  | Readonly<{ kind: "tool-end"; name: string; error: boolean; output: string; callId?: string }>
  | Readonly<{ kind: "subagent-start"; workerId: number; model: string; role?: string; goal: string }>
  | Readonly<{ kind: "subagent-end"; workerId: number; success: boolean; status?: string }>
  | Readonly<{ kind: "subagent-thinking-delta"; workerId: number; text: string }>
  | Readonly<{ kind: "subagent-assistant-delta"; workerId: number; text: string }>
  | Readonly<{ kind: "subagent-assistant-text"; workerId: number; text: string }>
  | Readonly<{ kind: "subagent-tool-start"; workerId: number; name: string; detail: string; callId?: string }>
  | Readonly<{ kind: "subagent-tool-end"; workerId: number; name: string; error: boolean; output: string; callId?: string }>
  | Readonly<{ kind: "context-compaction"; event: ContextCompactionUiEvent }>
  | Readonly<{ kind: "notice"; text: string; level?: string }>
  | Readonly<{ kind: "status"; key: string; text?: string }>
  | Readonly<{ kind: "widget"; key: string; lines?: readonly string[] }>
  | Readonly<{
    kind: "confirm-open";
    question: string;
    detail?: string;
    /** Semantic confirmation class (tool/merge/rollback/generic). */
    confirmKind?: ConfirmationRequest["kind"];
  }>
  | Readonly<{ kind: "confirm-close" }>
  | Readonly<{ kind: "select-open"; question: string; choices: readonly SelectChoice[] }>
  | Readonly<{ kind: "select-close" }>
  | Readonly<{ kind: "prompt-open"; question: string; secret?: boolean; placeholder?: string }>
  | Readonly<{ kind: "prompt-close" }>
  | Readonly<{ kind: "bypass"; enabled: boolean }>;

/** Bound pre-subscription buffer so prepareSession notices are not lost before Ink mounts. */
const PRE_SUBSCRIPTION_BUFFER_LIMIT = 64;

export class TuiSessionBridge implements InteractiveIO {
  readonly #listeners = new Set<(event: TuiEvent) => void>();
  /** Events emitted before the first subscriber; flushed once on first subscribe. */
  #preSubscriptionBuffer: TuiEvent[] = [];
  #preSubscriptionFlushed = false;
  #pendingAnswer: ((approved: boolean) => void) | undefined;
  #pendingSelect: ((value: string | undefined) => void) | undefined;
  #pendingPrompt: ((value: string | undefined) => void) | undefined;
  #bypass = false;

  readonly sink: SessionUiSink = {
    notify: (message, level) => {
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
    onToolEnd: (call, result) => {
      const raw = toolResultOutput(result);
      this.emit({
        kind: "tool-end",
        name: call.name,
        error: result.isError === true,
        // Display peels bash wrappers so empty-looking stdout wrappers still show files.
        output: formatToolOutputForDisplay(raw) || raw,
        callId: call.id,
      });
    },
    onContextCompaction: (event) => this.emit({ kind: "context-compaction", event }),
    onCancelled: () => this.emit({ kind: "notice", text: "Turn cancelled.", level: "warning" }),
    onDoneContract: (summary) => this.emit({ kind: "notice", text: summary, level: "warning" }),
  };

  /**
   * Open a confirmation. Detail must be passed explicitly — never sourced from a
   * global "last notice" side channel (stale-notice leakage).
   */
  readonly ask = async (
    question: string | ConfirmationRequest,
    detail?: string,
  ): Promise<boolean> => {
    const request = normalizeConfirmationRequest(question, detail);
    if (this.#bypass) {
      this.sink.notify?.(`Bypass auto-approved: ${request.question}`, "warning");
      return true;
    }
    this.assertIdle();
    this.emit({
      kind: "confirm-open",
      question: request.question,
      detail: request.detail,
      confirmKind: request.kind,
    });
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

  /**
   * Subscribe to UI events. The first subscriber receives any pre-subscription
   * buffer (startup notices/status from prepareSession) exactly once, in order.
   */
  subscribe(listener: (event: TuiEvent) => void): () => void {
    if (!this.#preSubscriptionFlushed) {
      this.#preSubscriptionFlushed = true;
      const buffered = this.#preSubscriptionBuffer;
      this.#preSubscriptionBuffer = [];
      for (const event of buffered) {
        listener(event);
      }
    }
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

  /** Test helper: count of events still buffered before first subscribe. */
  get preSubscriptionBufferLength(): number {
    return this.#preSubscriptionBuffer.length;
  }

  /** Bridge explore nested loops → scoped subagent TuiEvents (never primary live buffer). */
  createSubagentUiBridge(): SubagentUiBridge {
    return createTuiSubagentUiBridge((event) => this.emit(event));
  }

  private assertIdle(): void {
    if (this.interactionPending) {
      throw new Error("a TUI interaction is already pending");
    }
  }

  private emit(event: TuiEvent): void {
    if (this.#listeners.size === 0) {
      if (!this.#preSubscriptionFlushed) {
        this.#preSubscriptionBuffer.push(event);
        if (this.#preSubscriptionBuffer.length > PRE_SUBSCRIPTION_BUFFER_LIMIT) {
          this.#preSubscriptionBuffer.shift();
        }
      }
      return;
    }
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

export function createTuiSubagentUiBridge(
  emit: (event: TuiEvent) => void,
): SubagentUiBridge {
  return {
    forWorker: (input) => ({
      onLifecycle: (phase, meta) => {
        if (phase === "start") {
          emit({
            kind: "subagent-start",
            workerId: meta.workerId,
            model: meta.modelLabel,
            role: meta.role,
            goal: meta.goal,
          });
          return;
        }
        emit({
          kind: "subagent-end",
          workerId: meta.workerId,
          success: meta.success === true,
          status: meta.status,
        });
      },
      onThinkingDelta: (text) => emit({ kind: "subagent-thinking-delta", workerId: input.workerId, text }),
      onAssistantDelta: (text) => emit({ kind: "subagent-assistant-delta", workerId: input.workerId, text }),
      onAssistantText: (text) => emit({ kind: "subagent-assistant-text", workerId: input.workerId, text }),
      onToolStart: (call) => emit({
        kind: "subagent-tool-start",
        workerId: input.workerId,
        name: call.name,
        detail: toolCallDetail(call),
        callId: call.id,
      }),
      onToolEnd: (call, result) => {
        const raw = toolResultOutput(result);
        emit({
          kind: "subagent-tool-end",
          workerId: input.workerId,
          name: call.name,
          error: result.isError === true,
          output: formatToolOutputForDisplay(raw) || raw,
          callId: call.id,
        });
      },
    }),
  };
}

export function normalizeConfirmationRequest(
  question: string | ConfirmationRequest,
  detail?: string,
): ConfirmationRequest {
  if (typeof question === "string") {
    return {
      kind: "generic",
      question,
      ...(detail !== undefined ? { detail } : {}),
    };
  }
  return {
    kind: question.kind ?? "generic",
    question: question.question,
    detail: question.detail ?? detail,
    actionId: question.actionId,
    scopes: question.scopes,
  };
}
