import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeEventEmitter } from "./events/emitter.ts";
import { SessionStore } from "./session-store.ts";
import { TIMELINE_FILE, createTimelineRecorder, hashPrompt, toTimelineRecord } from "./session-timeline.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xio-timeline-"));
  dirs.push(root);
  const warnings: string[] = [];
  return { root, warnings, store: new SessionStore({ root, onWarning: (m) => warnings.push(m) }) };
}

const save = (store: SessionStore, id: string) =>
  store.save({ id, model: { provider: "p", id: "m" }, cwd: "/w", mainRoot: "/w", messages: [{ role: "user", content: "hi" }] });

describe("session timeline", () => {
  it("keeps boundary events only, with a prompt hash instead of the prompt", () => {
    const bus = createRuntimeEventEmitter({ sessionId: "s", runId: "r" });
    const start = toTimelineRecord(bus.emit("turn.start", { prompt: "secret plan", turnIndex: 1 }));
    expect(start).toMatchObject({ event: "turn.start", run: "r", promptHash: hashPrompt("secret plan") });
    expect(JSON.stringify(start)).not.toContain("secret plan");
    expect(toTimelineRecord(bus.emit("text.delta", { text: "x" }))).toBeUndefined();
    expect(toTimelineRecord(bus.emit("tool.result", { toolCallId: "c1", content: "big output" })))
      .toEqual(expect.objectContaining({ toolCallId: "c1" }));
    expect(JSON.stringify(toTimelineRecord(bus.emit("tool.result", { toolCallId: "c1", content: "big output" })))).not.toContain("big output");
  });

  it("waits for the first save instead of creating a session directory", async () => {
    const { root, store, warnings } = await tempStore();
    const bus = createRuntimeEventEmitter({ sessionId: "s1", runId: "r" });
    bus.subscribe(createTimelineRecorder(store, "s1"));
    bus.emit("turn.start", { prompt: "hi" });
    bus.emit("provider.request", {});
    await bus.flushPending();
    expect(await readdir(root)).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(warnings).toEqual([]);

    await save(store, "s1");
    bus.emit("harness.save_point", {});
    bus.emit("provider.done", { usage: { inputTokens: 3, outputTokens: 4, cacheTokens: null, reasoningTokens: null } });
    await bus.flushPending();
    const records = await store.readSideRecords("s1", TIMELINE_FILE);
    expect(records.map((r) => (r as { event: string }).event)).toEqual(["turn.start", "provider.request", "provider.done"]);
    expect((records[2] as { usage: { inputTokens: number } }).usage.inputTokens).toBe(3);
  });

  it("retries a failed write with the next event and reports the failure", async () => {
    let fail = true;
    const written: unknown[] = [];
    const sink = {
      appendSideRecords: async (_id: string, _file: string, records: readonly unknown[]) => {
        if (fail) throw new Error("disk full");
        written.push(...records);
        return true;
      },
    };
    const errors: string[] = [];
    const bus = createRuntimeEventEmitter({ sessionId: "s", runId: "r", onSubscriberError: (r) => errors.push(String(r.error)) });
    bus.subscribe(createTimelineRecorder(sink, "s"));
    bus.emit("turn.start", { prompt: "a" });
    await bus.flushPending();
    expect(errors.join()).toContain("disk full");
    fail = false;
    bus.emit("turn.end", { outcome: "success" });
    await bus.flushPending();
    expect(written.map((r) => (r as { event: string }).event)).toEqual(["turn.start", "turn.end"]);
  });

  it("skips a torn line with a warning and rejects paths outside the session", async () => {
    const { root, store, warnings } = await tempStore();
    await save(store, "s2");
    await store.appendSideRecords("s2", TIMELINE_FILE, [{ at: "2026-01-01T00:00:00.000Z", event: "turn.start" }]);
    await appendFile(path.join(root, "s2", TIMELINE_FILE), '{"at":"2026-01-01T00:00:01');
    expect(await store.readSideRecords("s2", TIMELINE_FILE)).toHaveLength(1);
    expect(warnings.join()).toContain("1 unreadable line");
    await expect(store.appendSideRecords("s2", "../state.json", [])).rejects.toThrow(/invalid session side file/);
  });
});
