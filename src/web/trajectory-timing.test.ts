import { describe, expect, it } from "vitest";

import { hashPrompt, type TimelineRecord } from "../runtime/session-timeline.ts";
import type { ChatMessage } from "../runtime/types.ts";
import { alignMessageTimes, parseTimelineRecords } from "./trajectory-timing.ts";

const t = (sec: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();
let seq = 0;
const rec = (sec: number, event: string, extra: Partial<TimelineRecord> = {}): TimelineRecord =>
  ({ at: t(sec), event, run: "r", seq: seq++, ...extra });
const usage = (input: number, output: number, cacheRead?: number) =>
  ({ inputTokens: input, outputTokens: output, cacheTokens: null, reasoningTokens: null, ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}) });

const messages: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "fix it" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "ls" } }] },
  { role: "tool", toolCallId: "c1", content: "a b" },
  { role: "assistant", content: "done" },
];

const turn = (offset: number, prompt: string): TimelineRecord[] => [
  rec(offset, "turn.start", { promptHash: hashPrompt(prompt) }),
  rec(offset + 1, "provider.request"),
  rec(offset + 3, "provider.done", { usage: usage(100, 10, 40) }),
  rec(offset + 3, "tool.call", { toolCallId: "c1" }),
  rec(offset + 7, "tool.result", { toolCallId: "c1" }),
  rec(offset + 8, "provider.request"),
  rec(offset + 9, "provider.done", { usage: usage(120, 5) }),
  rec(offset + 10, "turn.end", { outcome: "success" }),
];

describe("alignMessageTimes", () => {
  it("places user, model and tool steps on the recorded times", () => {
    const times = alignMessageTimes(messages, turn(0, "fix it"));
    expect(times.messages.get(1)).toEqual({ start: t(0), end: t(0) });
    expect(times.messages.get(2)).toEqual({ start: t(1), end: t(3) });
    expect(times.messages.get(4)).toEqual({ start: t(8), end: t(9) });
    expect(times.tools.get("c1")).toEqual({ start: t(3), end: t(7) });
    expect(times.activeMs).toBe(10_000);
    expect(times.usage).toEqual({ inputTokens: 220, outputTokens: 15, cacheReadTokens: 40, providerCalls: 2 });
  });

  it("leaves a turn untimed when no turn.start carries its prompt", () => {
    const times = alignMessageTimes(messages, turn(0, "something else"));
    expect(times.messages.size).toBe(0);
    // Tool calls still have their own anchor.
    expect(times.tools.get("c1")?.end).toBe(t(7));
  });

  it("with a failed extra provider call, times only messages anchored by their tools", () => {
    const records = turn(0, "fix it");
    // A request that never finished, then a retry: three requests, two dones for two messages is fine…
    records.splice(1, 0, rec(0, "provider.request"));
    expect(alignMessageTimes(messages, records).messages.get(4)).toEqual({ start: t(8), end: t(9) });
    // …but a third successful call (count mismatch) drops the order-based match for the final answer.
    records.push(rec(11, "provider.request"), rec(12, "provider.done"));
    const times = alignMessageTimes(messages, records);
    expect(times.messages.get(2)).toEqual({ start: t(1), end: t(3) });
    expect(times.messages.has(4)).toBe(false);
  });

  it("skips timeline turns that have no message (compacted or another prompt) and keeps order", () => {
    const records = [...turn(0, "older prompt"), ...turn(100, "fix it")];
    const times = alignMessageTimes(messages, records);
    expect(times.messages.get(1)?.start).toBe(t(100));
    expect(times.activeMs).toBe(20_000);
  });

  it("returns no times and no usage without a timeline", () => {
    const times = alignMessageTimes(messages, []);
    expect(times.messages.size).toBe(0);
    expect(times.activeMs).toBeNull();
    expect(times.usage).toBeNull();
  });

  it("drops records that are not timeline records", () => {
    expect(parseTimelineRecords([null, 3, { at: "nope", event: "x" }, { at: t(1), event: "turn.start" }])).toHaveLength(1);
  });
});
