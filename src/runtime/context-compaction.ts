import { emptyTokenUsage } from "./usage.ts";

import type {
  ChatMessage,
  ContextCompactionMode,
  ContextCompactionUiEvent,
  LlmClient,
  ModelInfo,
  TokenUsage,
} from "./types.ts";

export const CONTEXT_SUMMARY_NAME = "xiocode_context_summary";
export const MIN_MAX_SESSION_MESSAGES = 4;

const SUMMARY_SYSTEM_PROMPT = `You compact XioCode session history for continuation.
Return only a factual handoff summary. Preserve:
- the user's current goal and hard constraints
- important decisions and their rationale
- files changed or inspected
- failures, diagnostics, and verification results
- unfinished work and the next concrete steps
Do not invent completed work. Do not repeat secrets or credentials.`;

export type ContextCompactionResult = Readonly<{
  compacted: boolean;
  before: number;
  after: number;
  messages: readonly ChatMessage[];
  usage: TokenUsage;
}>;

export class ContextCompactionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContextCompactionError";
  }
}

export function isContextCompactionError(error: unknown): error is ContextCompactionError {
  return error instanceof ContextCompactionError;
}

type HistoryPersistence = (messages: readonly ChatMessage[]) => Promise<void> | void;

export class SessionHistory {
  #messages: ChatMessage[];
  readonly #persist?: HistoryPersistence;

  constructor(options: Readonly<{
    initialMessages?: readonly ChatMessage[];
    persist?: HistoryPersistence;
  }> = {}) {
    this.#messages = options.initialMessages ? [...options.initialMessages] : [];
    this.#persist = options.persist;
  }

  getMessages(): readonly ChatMessage[] {
    return [...this.#messages];
  }

  get length(): number {
    return this.#messages.length;
  }

  async replace(messages: readonly ChatMessage[]): Promise<void> {
    const candidate = [...messages];
    await this.#persist?.(candidate);
    this.#messages = candidate;
  }

  async persist(): Promise<void> {
    await this.#persist?.(this.getMessages());
  }
}

export class ContextCompactionController {
  readonly #history: SessionHistory;
  readonly #getClient: () => LlmClient;
  readonly #getModel: () => ModelInfo;
  readonly #maxMessages: number;
  readonly #onUiEvent?: (event: ContextCompactionUiEvent) => void;
  readonly #onRuntimeEvent?: (event: ContextCompactionUiEvent) => Promise<void> | void;
  #running = false;

  constructor(options: Readonly<{
    history: SessionHistory;
    getClient: () => LlmClient;
    getModel: () => ModelInfo;
    maxMessages: number;
    onUiEvent?: (event: ContextCompactionUiEvent) => void;
    onRuntimeEvent?: (event: ContextCompactionUiEvent) => Promise<void> | void;
  }>) {
    assertMaxSessionMessages(options.maxMessages);
    this.#history = options.history;
    this.#getClient = options.getClient;
    this.#getModel = options.getModel;
    this.#maxMessages = options.maxMessages;
    this.#onUiEvent = options.onUiEvent;
    this.#onRuntimeEvent = options.onRuntimeEvent;
  }

  needsAutomaticCompaction(incomingMessages = 2): boolean {
    return this.#history.length + incomingMessages > this.#maxMessages;
  }

  async compact(
    mode: ContextCompactionMode,
    focus?: string,
    signal?: AbortSignal,
  ): Promise<ContextCompactionResult> {
    if (this.#running) throw new Error("context compaction is already in progress");
    this.#running = true;
    const before = this.#history.length;
    try {
      await this.#emit({ stage: "start", mode, before });
      const result = await compactSessionMessages({
        messages: this.#history.getMessages(),
        client: this.#getClient(),
        model: this.#getModel().id,
        maxMessages: this.#maxMessages,
        focus,
        signal,
      });
      if (result.compacted) await this.#history.replace(result.messages);
      await this.#emit({
        stage: result.compacted ? "success" : "skip",
        mode,
        before: result.before,
        after: result.after,
        usage: result.usage,
      });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      await this.#emit({
        stage: "failure",
        mode,
        before,
        error: message,
      });
      throw isContextCompactionError(error)
        ? error
        : new ContextCompactionError(message, { cause: error });
    } finally {
      this.#running = false;
    }
  }

  async #emit(event: ContextCompactionUiEvent): Promise<void> {
    this.#onUiEvent?.(event);
    await this.#onRuntimeEvent?.(event);
  }
}

export async function compactSessionMessages(options: Readonly<{
  messages: readonly ChatMessage[];
  client: LlmClient;
  model: string;
  maxMessages: number;
  focus?: string;
  signal?: AbortSignal;
}>): Promise<ContextCompactionResult> {
  assertMaxSessionMessages(options.maxMessages);
  const plan = planCompaction(options.messages, options.maxMessages);
  if (!plan) {
    return {
      compacted: false,
      before: options.messages.length,
      after: options.messages.length,
      messages: [...options.messages],
      usage: emptyTokenUsage(),
    };
  }
  const completion = await options.client.complete({
    model: options.model,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: formatSummaryRequest(plan.older, options.focus) },
    ],
  }, { signal: options.signal });
  if (completion.toolCalls.length > 0) {
    throw new Error("context compaction returned tool calls; expected summary text only");
  }
  const summary = completion.content.trim();
  if (summary.length === 0) throw new Error("context compaction returned an empty summary");
  const summaryMessage: ChatMessage = {
    role: "system",
    name: CONTEXT_SUMMARY_NAME,
    content: `[context summary]\n${summary}`,
  };
  const messages = [...plan.baseSystem, summaryMessage, ...plan.recent.flatMap((turn) => turn)];
  assertMessageBudget(messages, options.maxMessages);
  if (messages.length >= options.messages.length) {
    throw new Error("context compaction did not reduce the session history");
  }
  return {
    compacted: true,
    before: options.messages.length,
    after: messages.length,
    messages,
    usage: completion.usage ?? emptyTokenUsage(),
  };
}

export function assertMessageBudget(messages: readonly ChatMessage[], maxMessages: number): void {
  assertMaxSessionMessages(maxMessages);
  if (messages.length > maxMessages) {
    throw new Error(
      `session context has ${messages.length} messages, exceeding max_session_messages=${maxMessages}; run /compact or start a new session`,
    );
  }
}

export function assertMaxSessionMessages(value: number): void {
  if (!Number.isInteger(value) || value < MIN_MAX_SESSION_MESSAGES) {
    throw new Error(`general.max_session_messages must be an integer >= ${MIN_MAX_SESSION_MESSAGES}`);
  }
}

type CompactionPlan = Readonly<{
  baseSystem: readonly ChatMessage[];
  older: readonly ChatMessage[];
  recent: readonly (readonly ChatMessage[])[];
}>;

function planCompaction(messages: readonly ChatMessage[], maxMessages: number): CompactionPlan | undefined {
  const { baseSystem, prelude, turns } = splitIntoTurns(messages);
  if (turns.length < 2 && prelude.length === 0) return undefined;
  const hardRecentBudget = maxMessages - baseSystem.length - 1;
  const latest = turns.at(-1);
  if (!latest || latest.length > hardRecentBudget) {
    throw new Error("the latest complete turn is too large to retain after context compaction");
  }
  const preferredRecentBudget = Math.max(
    latest.length,
    Math.floor(maxMessages * 0.4) - baseSystem.length - 1,
  );
  const recent: (readonly ChatMessage[])[] = [latest];
  let recentCount = latest.length;
  for (let index = turns.length - 2; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (recentCount + turn.length > preferredRecentBudget) break;
    recent.unshift(turn);
    recentCount += turn.length;
  }
  const olderTurnCount = turns.length - recent.length;
  const older = [...prelude, ...turns.slice(0, olderTurnCount).flatMap((turn) => turn)];
  if (baseSystem.length + 1 + recentCount >= messages.length) return undefined;
  return older.length > 0 ? { baseSystem, older, recent } : undefined;
}

function splitIntoTurns(messages: readonly ChatMessage[]): Readonly<{
  baseSystem: readonly ChatMessage[];
  prelude: readonly ChatMessage[];
  turns: readonly (readonly ChatMessage[])[];
}> {
  const baseSystem = messages[0]?.role === "system" ? [messages[0]] : [];
  const prelude: ChatMessage[] = [];
  const turns: ChatMessage[][] = [];
  let pendingSystem: ChatMessage[] = [];
  let current: ChatMessage[] | undefined;
  for (const message of messages.slice(baseSystem.length)) {
    if (message.role === "system") {
      if (current) turns.push(current);
      current = undefined;
      pendingSystem.push(message);
      continue;
    }
    if (message.role === "user") {
      if (current) turns.push(current);
      current = [...pendingSystem, message];
      pendingSystem = [];
      continue;
    }
    if (current) current.push(message);
    else prelude.push(...pendingSystem.splice(0), message);
  }
  if (current) turns.push(current);
  prelude.push(...pendingSystem);
  return { baseSystem, prelude, turns };
}

function formatSummaryRequest(messages: readonly ChatMessage[], focus?: string): string {
  const focusText = focus?.trim();
  const transcript = messages.map((message, index) => formatMessage(message, index + 1)).join("\n\n");
  return [
    focusText ? `User focus for this compaction: ${focusText}` : undefined,
    "Create a continuation handoff from this older session history:",
    transcript,
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}

function formatMessage(message: ChatMessage, index: number): string {
  const toolCalls = message.toolCalls?.length
    ? `\ntool_calls: ${JSON.stringify(message.toolCalls)}`
    : "";
  const toolIdentity = message.role === "tool"
    ? ` tool_call_id=${message.toolCallId ?? "unknown"} name=${message.name ?? "unknown"}`
    : "";
  return `[${index}] ${message.role}${toolIdentity}\n${message.content}${toolCalls}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
