import type { ChatMessage } from "../types.ts";

/**
 * Approximate token estimator for budget pressure (not a model tokenizer).
 * Uses UTF-16 code units / 4, rounded up — good enough for compaction gates.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = estimateTextTokens(message.content);
  if (message.name) total += estimateTextTokens(message.name);
  if (message.toolCallId) total += estimateTextTokens(message.toolCallId);
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      total += estimateTextTokens(call.name);
      total += estimateTextTokens(JSON.stringify(call.arguments ?? {}));
      total += 8; // id / framing overhead
    }
  }
  return total + 4; // role framing
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}

/**
 * Resolve the session token budget used for automatic compaction pressure.
 * Prefer explicit config; else 75% of model context window; else undefined (message-only).
 */
export function resolveSessionTokenBudget(input: Readonly<{
  configured?: number;
  contextWindow?: number;
  /** Fraction of context window reserved for output + next tools. Default 0.25. */
  outputReserveFraction?: number;
}>): number | undefined {
  if (input.configured !== undefined) {
    if (!Number.isInteger(input.configured) || input.configured < 1024) {
      throw new Error("general.max_session_tokens must be an integer >= 1024");
    }
    return input.configured;
  }
  const window = input.contextWindow;
  if (typeof window !== "number" || !Number.isFinite(window) || window < 2048) {
    return undefined;
  }
  const reserve = input.outputReserveFraction ?? 0.25;
  return Math.max(1024, Math.floor(window * (1 - reserve)));
}
