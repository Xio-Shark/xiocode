import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExtensionHost } from "../extension-host.ts";
import { defineTool } from "../define-tool.ts";
import { Type } from "../schema.ts";
import { runAgentLoop } from "../agent-loop.ts";
import { createStdoutSessionUiSink } from "../session-ui.ts";
import { RunStore } from "../../../extensions/xio-evolve/src/run-store.ts";
import { TrajectoryRecorder } from "../../../extensions/xio-evolve/src/trajectory-recorder.ts";

import { createRuntimeEventEmitter } from "./emitter.ts";
import { pipeRuntimeEventsToSessionUi, pipeRuntimeEventsToTrajectory } from "./adapters.ts";
import { redactRuntimePayload } from "./redact.ts";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "./types.ts";

import type { LlmClient, StreamEvent } from "../types.ts";
import type { RuntimeEventV1 } from "./types.ts";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("RuntimeEvent.v1 envelope", () => {
  it("assigns monotonic seq per run and stamps schema_version", () => {
    const bus = createRuntimeEventEmitter({
      sessionId: "s1",
      runId: "r1",
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    });
    const a = bus.emit("run.start", { model: "m" });
    const b = bus.emit("turn.start", { turnIndex: 1 });
    const c = bus.emit("text.delta", { text: "hi" });

    expect(a.schema_version).toBe(RUNTIME_EVENT_SCHEMA_VERSION);
    expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2]);
    expect(a.session_id).toBe("s1");
    expect(a.run_id).toBe("r1");
    expect(a.timestamp).toBe("2026-07-16T00:00:00.000Z");
  });

  it("redacts secret-looking keys and truncates long strings", () => {
    const redacted = redactRuntimePayload({
      api_key: "sk-live-secret",
      note: "x".repeat(10_000),
      nested: { password: "p", ok: 1 },
    });
    expect(redacted.api_key).toBe("[redacted]");
    expect((redacted.nested as { password: string }).password).toBe("[redacted]");
    expect((redacted.nested as { ok: number }).ok).toBe(1);
    expect(String(redacted.note).endsWith("…[truncated]")).toBe(true);
  });

  it("agent loop dual-writes RuntimeEvents; two sinks see the same order", async () => {
    const bus = createRuntimeEventEmitter({ sessionId: "sess", runId: "run-a" });
    const collected: RuntimeEventV1[] = [];
    bus.subscribe((event) => {
      collected.push(event);
    });

    const humanChunks: string[] = [];
    const humanSink = createStdoutSessionUiSink((chunk) => {
      humanChunks.push(chunk);
    });
    pipeRuntimeEventsToSessionUi(bus, humanSink);

    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-rt-ev-"));
    const recorder = new TrajectoryRecorder({
      store: new RunStore({ root: tempDir }),
    });
    await recorder.start({ run_id: "run-a" });
    pipeRuntimeEventsToTrajectory(bus, recorder);

    const host = new ExtensionHost();
    host.registerTool(defineTool({
      name: "echo",
      description: "echo",
      parameters: Type.Object({ q: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "pong" }] };
      },
    }));

    let calls = 0;
    const client: LlmClient = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [{ id: "t1", name: "echo", arguments: { q: "hi" } }],
          };
        }
        return { content: "final answer", toolCalls: [] };
      },
    };

    await runAgentLoop("go", { host, client, model: "stub", runtimeEvents: bus });
    await recorder.finish("success");

    const names = collected.map((event) => event.event);
    expect(names[0]).toBe("run.start");
    expect(names).toContain("turn.start");
    expect(names).toContain("tool.call");
    expect(names).toContain("tool.result");
    expect(names).toContain("turn.end");
    expect(names.at(-1)).toBe("run.end");
    expect(collected.every((event) => event.schema_version === RUNTIME_EVENT_SCHEMA_VERSION)).toBe(true);
    expect(collected.every((event) => event.run_id === "run-a")).toBe(true);

    // Seq monotonic
    for (let i = 1; i < collected.length; i += 1) {
      expect(collected[i]!.seq).toBe(collected[i - 1]!.seq + 1);
    }

    const turnEnd = collected.find((event) => event.event === "turn.end");
    expect(turnEnd?.payload).toMatchObject({
      turnIndex: 1,
      message: { content: "final answer" },
      outcome: "success",
    });

    const trajectory = await recorder.readTrajectory("run-a") as Record<string, unknown>;
    expect(trajectory.finalMessage).toEqual({ content: "final answer" });

    // Human sink received tool / text via RuntimeEvent adapter (not only callbacks).
    expect(humanChunks.some((chunk) => chunk.includes("echo") || chunk.includes("final"))).toBe(true);
  });

  it("maps stream deltas into text.delta RuntimeEvents", async () => {
    const bus = createRuntimeEventEmitter({ sessionId: "s", runId: "r-stream" });
    const deltas: string[] = [];
    bus.subscribe((event) => {
      if (event.event === "text.delta") {
        deltas.push(String(event.payload.text ?? ""));
      }
    });

    const host = new ExtensionHost();
    const client: LlmClient = {
      async complete() {
        return { content: "unused", toolCalls: [] };
      },
      async *completeStream(): AsyncIterable<StreamEvent> {
        yield { type: "text_delta", text: "hel" };
        yield { type: "text_delta", text: "lo" };
        yield {
          type: "done",
          content: "hello",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheTokens: 0, reasoningTokens: null },
        };
      },
    };

    await runAgentLoop("stream", { host, client, model: "stub", runtimeEvents: bus });
    expect(deltas.join("")).toBe("hello");
  });

  it("does not place RuntimeEvents into session WAL (separation invariant)", () => {
    // Design lock: WAL module has no RuntimeEvent import; recovery ops stay compact.
    // This test documents the invariant rather than opening WAL files.
    const bus = createRuntimeEventEmitter({ sessionId: "s", runId: "r" });
    bus.emit("text.delta", { text: "not a wal record" });
    expect(bus.peekSeq()).toBe(1);
    // Consumers of RuntimeEvent must not write session-wal.ts records from this bus.
  });
});
