/**
 * Puts session messages on the time axis recorded in timeline.jsonl.
 *
 * Messages carry no timestamps, so every match needs an anchor:
 *   - a tool call is matched by its toolCallId (tool.call → tool.result/error);
 *   - a user message by the hash of the turn.start prompt;
 *   - an assistant message by the provider call that produced it: inside one
 *     turn, provider calls and assistant messages pair up in order, and a
 *     message that issued tools must have finished before those tools started.
 * Whatever cannot be anchored stays untimed — the page shows it as such
 * instead of inventing a position.
 */

import { hashPrompt, type TimelineRecord } from "../runtime/session-timeline.ts";
import type { ChatMessage } from "../runtime/types.ts";

export type Span = Readonly<{ start: string; end?: string }>;

export type TimelineUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  /** null when no provider call reported cache reads. */
  cacheReadTokens: number | null;
  providerCalls: number;
}>;

export type MessageTimes = Readonly<{
  /** By message index (user and assistant messages). */
  messages: ReadonlyMap<number, Span>;
  /** By toolCallId. */
  tools: ReadonlyMap<string, Span>;
  /** Sum of turn durations (turn.start → turn.end, or the turn's last record). */
  activeMs: number | null;
  usage: TimelineUsage | null;
}>;

type TimelineTurn = Readonly<{
  promptHash?: string;
  start: string;
  records: readonly TimelineRecord[];
}>;

/** Tolerance for "the model finished before its tools started" (clock granularity). */
const ORDER_SLACK_MS = 50;

export function parseTimelineRecords(raw: readonly unknown[]): TimelineRecord[] {
  return raw.filter((r): r is TimelineRecord => {
    const o = r as Record<string, unknown> | null;
    return typeof o === "object" && o !== null && typeof o.at === "string" && typeof o.event === "string"
      && Number.isFinite(Date.parse(o.at));
  });
}

export function alignMessageTimes(messages: readonly ChatMessage[], records: readonly TimelineRecord[]): MessageTimes {
  const tools = toolSpans(records);
  const turns = splitTurns(records);
  const times = new Map<number, Span>();
  let nextTurn = 0;
  for (const segment of userSegments(messages)) {
    const hash = hashPrompt(messages[segment.user]!.content);
    const found = turns.findIndex((t, i) => i >= nextTurn && t.promptHash === hash);
    if (found < 0) continue;
    nextTurn = found + 1;
    const turn = turns[found]!;
    times.set(segment.user, { start: turn.start, end: turn.start });
    assignAssistants(messages, segment.assistants, providerSpans(turn.records), tools, times);
  }
  return { messages: times, tools, activeMs: activeMs(turns), usage: usage(records) };
}

function toolSpans(records: readonly TimelineRecord[]): Map<string, Span> {
  const spans = new Map<string, Span>();
  for (const r of records) {
    if (!r.toolCallId) continue;
    if (r.event === "tool.call") spans.set(r.toolCallId, { start: r.at });
    else if ((r.event === "tool.result" || r.event === "tool.error") && spans.has(r.toolCallId)) {
      spans.set(r.toolCallId, { start: spans.get(r.toolCallId)!.start, end: r.at });
    }
  }
  return spans;
}

function splitTurns(records: readonly TimelineRecord[]): TimelineTurn[] {
  const turns: { promptHash?: string; start: string; records: TimelineRecord[] }[] = [];
  for (const r of records) {
    if (r.event === "turn.start") turns.push({ promptHash: r.promptHash, start: r.at, records: [] });
    else turns.at(-1)?.records.push(r);
  }
  return turns;
}

/** Each user message with the assistant messages that answer it (up to the next user message). */
function userSegments(messages: readonly ChatMessage[]): { user: number; assistants: number[] }[] {
  const segments: { user: number; assistants: number[] }[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") segments.push({ user: i, assistants: [] });
    else if (m.role === "assistant") segments.at(-1)?.assistants.push(i);
  });
  return segments;
}

/** Successful provider calls: a request followed by its done (a request with no done failed or was cut off). */
function providerSpans(records: readonly TimelineRecord[]): { start: string; end: string }[] {
  const spans: { start: string; end: string }[] = [];
  let open: string | undefined;
  for (const r of records) {
    if (r.event === "provider.request") open = r.at;
    else if (r.event === "provider.done" && open) {
      spans.push({ start: open, end: r.at });
      open = undefined;
    }
  }
  return spans;
}

function firstToolStart(message: ChatMessage, tools: ReadonlyMap<string, Span>): number | undefined {
  const starts = (message.toolCalls ?? [])
    .map((call) => tools.get(call.id)?.start)
    .filter((s): s is string => s !== undefined)
    .map((s) => Date.parse(s));
  return starts.length ? Math.min(...starts) : undefined;
}

function assignAssistants(
  messages: readonly ChatMessage[],
  assistants: readonly number[],
  spans: readonly { start: string; end: string }[],
  tools: ReadonlyMap<string, Span>,
  out: Map<number, Span>,
): void {
  const consistent = spans.length === assistants.length && assistants.every((index, k) => {
    const toolStart = firstToolStart(messages[index]!, tools);
    return toolStart === undefined || Date.parse(spans[k]!.end) <= toolStart + ORDER_SLACK_MS;
  });
  if (consistent) {
    assistants.forEach((index, k) => out.set(index, spans[k]!));
    return;
  }
  // Counts differ (a retried or cancelled call): only messages that issued tools have an anchor —
  // the last provider call that finished before their first tool started.
  for (const index of assistants) {
    const toolStart = firstToolStart(messages[index]!, tools);
    if (toolStart === undefined) continue;
    const span = [...spans].reverse().find((s) => Date.parse(s.end) <= toolStart + ORDER_SLACK_MS);
    if (span) out.set(index, span);
  }
}

function activeMs(turns: readonly TimelineTurn[]): number | null {
  if (turns.length === 0) return null;
  return turns.reduce((sum, t) => {
    const end = t.records.find((r) => r.event === "turn.end")?.at ?? t.records.at(-1)?.at ?? t.start;
    return sum + Math.max(0, Date.parse(end) - Date.parse(t.start));
  }, 0);
}

function usage(records: readonly TimelineRecord[]): TimelineUsage | null {
  const done = records.filter((r) => r.event === "provider.done" && r.usage);
  if (done.length === 0) return null;
  let cache: number | null = null;
  let input = 0;
  let output = 0;
  for (const r of done) {
    input += r.usage!.inputTokens ?? 0;
    output += r.usage!.outputTokens ?? 0;
    if (typeof r.usage!.cacheReadTokens === "number") cache = (cache ?? 0) + r.usage!.cacheReadTokens;
  }
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cache, providerCalls: done.length };
}
