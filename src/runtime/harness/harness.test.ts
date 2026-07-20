import { describe, expect, it } from "vitest";

import { ExtensionHost } from "../extension-host.ts";
import { createRuntimeEventEmitter } from "../events/emitter.ts";
import { createPromptRunner } from "../session-lifecycle.ts";
import { runAgentLoop } from "../agent-loop.ts";
import { createScriptedLlmClient, parseAgentTape } from "../providers/scripted/index.ts";
import {
  HarnessController,
  SessionBusyError,
  createTurnSnapshot,
  isSessionBusyError,
} from "./index.ts";

import type { LlmClient, ModelInfo } from "../types.ts";
import type { TurnSnapshot } from "./turn-snapshot.ts";

/** Deferred promise barrier — no sleep races. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TurnSnapshot", () => {
  it("freezes model identity so later live mutation cannot rewrite the snapshot", () => {
    const liveModel = { provider: "a", id: "one" };
    const snap = createTurnSnapshot({
      model: liveModel,
      modelId: liveModel.id,
      providerApi: "openai-completions",
      client: { async complete() { return { content: "", toolCalls: [] }; } },
      parallelToolCalls: true,
      tools: [],
    });
    liveModel.id = "mutated";
    expect(snap.modelId).toBe("one");
    expect(snap.model.id).toBe("one");
  });
});

describe("HarnessController admission", () => {
  it("rejects a second structural prompt while busy (no sleep)", async () => {
    const harness = new HarnessController({ emitEvents: false });
    harness.begin("prompt");
    expect(harness.phase).toBe("turn");
    expect(() => harness.begin("prompt")).toThrow(SessionBusyError);
    expect(() => harness.begin("compaction")).toThrow(SessionBusyError);
    await harness.end();
    expect(harness.phase).toBe("idle");
    harness.begin("compaction");
    expect(harness.phase).toBe("compaction");
    await harness.end();
  });

  it("waitForIdle does not resolve before tracked listener settle completes", async () => {
    const harness = new HarnessController({ emitEvents: false });
    const gate = deferred();
    let listenerDone = false;

    harness.begin("prompt");
    harness.trackSettle((async () => {
      await gate.promise;
      listenerDone = true;
    })());

    let idleResolved = false;
    const waiting = harness.waitForIdle().then(() => {
      idleResolved = true;
    });

    // end() flushes pending — must not finish until gate opens.
    const ending = harness.end();
    await Promise.resolve();
    expect(idleResolved).toBe(false);
    expect(listenerDone).toBe(false);

    gate.resolve();
    await ending;
    await waiting;
    expect(listenerDone).toBe(true);
    expect(idleResolved).toBe(true);
    expect(harness.phase).toBe("idle");
  });
});

describe("createPromptRunner busy admission", () => {
  it("second structural prompt fails busy while the first is in-flight", async () => {
    const host = new ExtensionHost();
    const harness = new HarnessController({ emitEvents: false });
    const gate = deferred();
    const client: LlmClient = {
      async complete() {
        await gate.promise;
        return { content: "done", toolCalls: [] };
      },
    };
    const runPrompt = createPromptRunner({
      host,
      client,
      model: { provider: "test", id: "stub" },
      providerApi: "openai-completions",
      verify: { enabled: false, requireAllPass: true, repairTurns: 0, commands: [] },
      harness,
    });

    const first = runPrompt("one");
    // Microtask: begin() already flipped phase before complete() awaits gate.
    await Promise.resolve();
    expect(harness.phase).toBe("turn");

    await expect(runPrompt("two")).rejects.toSatisfy(isSessionBusyError);

    gate.resolve();
    await first;
    await harness.waitForIdle();
    expect(harness.phase).toBe("idle");
  });
});

describe("TurnSnapshot provider isolation (barrier)", () => {
  it("live model change does not alter the in-flight provider request snapshot", async () => {
    const host = new ExtensionHost();
    const snapshots: TurnSnapshot[] = [];
    const modelsSeen: string[] = [];

    let liveModel: ModelInfo = { provider: "scripted", id: "model-a" };
    const firstEntered = deferred();
    const releaseFirst = deferred();

    host.registerTool({
      name: "noop",
      description: "noop",
      parameters: { type: "object", properties: {} },
      async execute() {
        // After first request completes, flip live config for the next snapshot.
        liveModel = { provider: "scripted", id: "model-b" };
        return { content: [{ type: "text", text: "ok" }] };
      },
    });

    let call = 0;
    const client: LlmClient = {
      async complete(request) {
        call += 1;
        modelsSeen.push(request.model);
        if (call === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
          return {
            content: "",
            toolCalls: [{ id: "c1", name: "noop", arguments: {} }],
          };
        }
        return { content: "final", toolCalls: [] };
      },
    };

    const pending = runAgentLoop("go", {
      host,
      client,
      model: liveModel.id,
      providerName: liveModel.provider,
      providerApi: "openai-completions",
      getLiveConfig: () => ({
        model: liveModel,
        modelId: liveModel.id,
        providerName: liveModel.provider,
        providerApi: "openai-completions",
        client,
        parallelToolCalls: true,
        tools: host.listTools(),
      }),
      onTurnSnapshot: (snap) => {
        snapshots.push(snap);
      },
    });

    await firstEntered.promise;
    expect(snapshots[0]?.modelId).toBe("model-a");
    // Mutate live while first provider request is still in-flight.
    liveModel = { provider: "scripted", id: "model-mutated-during-flight" };
    expect(snapshots[0]!.modelId).toBe("model-a");

    releaseFirst.resolve();
    const loopResult = await pending;
    expect(loopResult.finalText).toBe("final");
    expect(modelsSeen[0]).toBe("model-a");
    expect(modelsSeen.at(-1)).toBe("model-b");
    expect(snapshots[0]!.modelId).toBe("model-a");
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots[1]!.modelId).toBe("model-b");
  });
});

describe("RuntimeEvent flushPending settle", () => {
  it("flushPending waits for async subscribers (barrier, no sleep)", async () => {
    const bus = createRuntimeEventEmitter({ sessionId: "s", runId: "r" });
    const gate = deferred();
    let finished = false;
    bus.subscribe(async (event) => {
      if (event.event !== "harness.save_point") return;
      await gate.promise;
      finished = true;
    });

    bus.emit("harness.save_point", { phase: "turn_complete" });
    const flushing = bus.flushPending();
    await Promise.resolve();
    expect(finished).toBe(false);
    gate.resolve();
    await flushing;
    expect(finished).toBe(true);
  });
});

describe("scripted barrier + harness settle ordering", () => {
  it("persists checkpoint before listener settle completes", async () => {
    const host = new ExtensionHost();
    const bus = createRuntimeEventEmitter({ sessionId: "s", runId: "r-settle" });
    const harness = new HarnessController({ runtimeEvents: bus });
    const persistOrder: string[] = [];
    const persistEntered = deferred();
    const listenerGate = deferred();
    const listenerStarted = deferred();

    bus.subscribe(async (event) => {
      if (event.event !== "harness.save_point") return;
      // Only block the first save_point listener to prove ordering.
      if (persistOrder.includes("listener-start")) return;
      persistOrder.push("listener-start");
      listenerStarted.resolve();
      await listenerGate.promise;
      persistOrder.push("listener-end");
    });

    const tape = parseAgentTape({
      schema_version: "xio-agent-tape.v1",
      name: "settle",
      turns: [{ steps: [{ type: "delta", channel: "text", chunks: ["ok"] }, { type: "done" }] }],
    });
    const client = createScriptedLlmClient({ tape });

    const runPrompt = createPromptRunner({
      host,
      client,
      model: { provider: "scripted", id: "scripted" },
      providerApi: "openai-completions",
      verify: { enabled: false, requireAllPass: true, repairTurns: 0, commands: [] },
      harness,
      runtimeEvents: bus,
      onCheckpoint: async () => {
        if (!persistOrder.includes("persist")) {
          persistOrder.push("persist");
          persistEntered.resolve();
        }
      },
    });

    const pending = runPrompt("hi");
    await persistEntered.promise;
    expect(persistOrder[0]).toBe("persist");

    await listenerStarted.promise;
    expect(persistOrder.indexOf("persist")).toBeLessThan(persistOrder.indexOf("listener-start"));
    expect(persistOrder).not.toContain("listener-end");

    listenerGate.resolve();
    await pending;
    await harness.waitForIdle();
    expect(persistOrder[0]).toBe("persist");
    expect(persistOrder).toContain("listener-start");
    expect(persistOrder).toContain("listener-end");
    expect(persistOrder.indexOf("persist")).toBeLessThan(persistOrder.indexOf("listener-start"));
    expect(persistOrder.indexOf("listener-start")).toBeLessThan(persistOrder.indexOf("listener-end"));
  });
});
