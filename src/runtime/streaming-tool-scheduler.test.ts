import { describe, expect, it } from "vitest";

import { FileWriteQueue } from "./file-write-queue.ts";
import {
  StreamingToolScheduler,
  isWriteSerialTool,
} from "./streaming-tool-scheduler.ts";
import type { ChatToolCall, ToolExecuteResult } from "./types.ts";

function call(id: string, name: string, args: Record<string, unknown> = {}): ChatToolCall {
  return { id, name, arguments: args };
}

function ok(text: string): ToolExecuteResult {
  return { content: [{ type: "text", text }] };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("isWriteSerialTool", () => {
  it("marks write/edit/plan as serial", () => {
    expect(isWriteSerialTool("write")).toBe(true);
    expect(isWriteSerialTool("edit")).toBe(true);
    expect(isWriteSerialTool("plan")).toBe(true);
    expect(isWriteSerialTool("read")).toBe(false);
    expect(isWriteSerialTool("bash")).toBe(false);
  });
});

describe("StreamingToolScheduler", () => {
  it("returns results in enqueue order even when later calls finish first", async () => {
    const slow = deferred<ToolExecuteResult>();
    const fast = deferred<ToolExecuteResult>();
    const started: string[] = [];

    const scheduler = new StreamingToolScheduler({
      async execute(c) {
        started.push(c.id);
        if (c.id === "1") return slow.promise;
        return fast.promise;
      },
    });

    scheduler.enqueue(call("1", "read", { path: "a.ts" }));
    scheduler.enqueue(call("2", "read", { path: "b.ts" }));

    expect(started).toEqual(["1", "2"]);

    fast.resolve(ok("fast"));
    // Wait a microtask so #2 can settle while #1 is still pending.
    await Promise.resolve();
    slow.resolve(ok("slow"));

    const ordered = await scheduler.waitAllOrdered();
    expect(ordered.map((row) => row.call.id)).toEqual(["1", "2"]);
    expect(ordered.map((row) => row.result.content[0]?.text)).toEqual(["slow", "fast"]);
  });

  it("fires onToolStart as soon as execute begins (before waitAllOrdered)", async () => {
    const gate = deferred<ToolExecuteResult>();
    const starts: string[] = [];
    let startBeforeWait = false;

    const scheduler = new StreamingToolScheduler({
      async execute(c) {
        starts.push(c.id);
        return gate.promise;
      },
      onToolStart(c) {
        starts.push(`start:${c.id}`);
      },
    });

    scheduler.enqueue(call("t1", "bash", { command: "echo hi" }));
    await Promise.resolve();
    startBeforeWait = starts.includes("start:t1");
    expect(startBeforeWait).toBe(true);

    gate.resolve(ok("hi"));
    await scheduler.waitAllOrdered();
  });

  it("runs non-write tools concurrently when parallelToolCalls is true", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const release = deferred<void>();

    const scheduler = new StreamingToolScheduler({
      parallelToolCalls: true,
      async execute() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await release.promise;
        inFlight -= 1;
        return ok("ok");
      },
    });

    scheduler.enqueue(call("1", "read", { path: "a" }));
    scheduler.enqueue(call("2", "grep", { pattern: "x" }));
    await Promise.resolve();
    expect(maxInFlight).toBe(2);
    release.resolve();
    await scheduler.waitAllOrdered();
  });

  it("serializes same-path write tools via FileWriteQueue", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];

    const scheduler = new StreamingToolScheduler({
      parallelToolCalls: true,
      fileWriteQueue: new FileWriteQueue(),
      async execute(c) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(`${c.id}:start`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`${c.id}:end`);
        inFlight -= 1;
        return ok(`wrote ${String(c.arguments.path)}`);
      },
    });

    scheduler.enqueue(call("1", "write", { path: "same.ts", content: "a" }));
    scheduler.enqueue(call("2", "write", { path: "same.ts", content: "b" }));
    await scheduler.waitAllOrdered();

    expect(maxInFlight).toBe(1);
    expect(order).toEqual(["1:start", "1:end", "2:start", "2:end"]);
  });

  it("allows different-path write tools to overlap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const release = deferred<void>();
    const bothStarted = deferred<void>();
    let startedCount = 0;

    const scheduler = new StreamingToolScheduler({
      parallelToolCalls: true,
      async execute() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        startedCount += 1;
        if (startedCount === 2) bothStarted.resolve();
        await release.promise;
        inFlight -= 1;
        return ok("ok");
      },
    });

    scheduler.enqueue(call("1", "write", { path: "a.ts", content: "a" }));
    scheduler.enqueue(call("2", "write", { path: "b.ts", content: "b" }));
    await bothStarted.promise;
    expect(maxInFlight).toBe(2);
    release.resolve();
    await scheduler.waitAllOrdered();
  });

  it("runs strictly in enqueue order when parallelToolCalls is false", async () => {
    const order: string[] = [];
    const first = deferred<ToolExecuteResult>();

    const scheduler = new StreamingToolScheduler({
      parallelToolCalls: false,
      async execute(c) {
        order.push(`${c.id}:start`);
        if (c.id === "1") return first.promise;
        order.push(`${c.id}:end`);
        return ok(c.id);
      },
    });

    scheduler.enqueue(call("1", "read", { path: "a" }));
    scheduler.enqueue(call("2", "read", { path: "b" }));
    await Promise.resolve();
    expect(order).toEqual(["1:start"]);

    first.resolve(ok("1"));
    await scheduler.waitAllOrdered();
    expect(order).toEqual(["1:start", "2:start", "2:end"]);
  });

  it("abort synthesizes isError results for in-flight and not-started calls", async () => {
    const hang = deferred<ToolExecuteResult>();
    const ends: Array<{ id: string; isError?: boolean; text: string }> = [];

    const scheduler = new StreamingToolScheduler({
      parallelToolCalls: false,
      async execute(c, signal) {
        if (c.id === "1") {
          return new Promise((resolve, reject) => {
            const onAbort = () => {
              hang.reject(new Error("aborted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            hang.promise.then(resolve, reject).finally(() => {
              signal.removeEventListener("abort", onAbort);
            });
          });
        }
        return ok(c.id);
      },
      onToolEnd(c, result) {
        ends.push({
          id: c.id,
          isError: result.isError,
          text: result.content[0]?.text ?? "",
        });
      },
    });

    scheduler.enqueue(call("1", "bash", { command: "sleep" }));
    scheduler.enqueue(call("2", "read", { path: "x" }));
    await Promise.resolve();

    scheduler.abort("session abort");
    const ordered = await scheduler.waitAllOrdered();

    expect(ordered).toHaveLength(2);
    expect(ordered.every((row) => row.result.isError === true)).toBe(true);
    expect(ordered[0]!.result.content[0]?.text).toContain("session abort");
    expect(ordered[1]!.result.content[0]?.text).toContain("session abort");
    expect(ends.every((e) => e.isError === true)).toBe(true);
  });

  it("external AbortSignal triggers abort", async () => {
    const ac = new AbortController();
    const hang = deferred<ToolExecuteResult>();

    const scheduler = new StreamingToolScheduler({
      signal: ac.signal,
      async execute() {
        return hang.promise;
      },
    });

    scheduler.enqueue(call("1", "read", { path: "a" }));
    ac.abort();
    const ordered = await scheduler.waitAllOrdered();
    expect(scheduler.aborted).toBe(true);
    expect(ordered[0]!.result.isError).toBe(true);
    expect(ordered[0]!.result.content[0]?.text).toContain("AbortSignal aborted");
  });

  it("enqueue after abort still yields a synthetic error result", async () => {
    const scheduler = new StreamingToolScheduler({
      async execute() {
        return ok("should not run");
      },
    });
    scheduler.abort("already done");
    scheduler.enqueue(call("late", "read", { path: "z" }));
    const ordered = await scheduler.waitAllOrdered();
    expect(ordered).toHaveLength(1);
    expect(ordered[0]!.result.isError).toBe(true);
    expect(ordered[0]!.result.content[0]?.text).toContain("already done");
  });
});
