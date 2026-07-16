import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ExtensionHost } from "../../extension-host.ts";
import { defineTool } from "../../define-tool.ts";
import { Type } from "../../schema.ts";
import { runAgentLoop } from "../../agent-loop.ts";
import { createRuntimeEventEmitter } from "../../events/index.ts";

import { createScriptedLlmClient } from "./client.ts";
import { AgentTapeError, loadAgentTape, parseAgentTape } from "./load-tape.ts";
import { normalizeRuntimeEventsForGolden, runtimeEventNames } from "./golden.ts";

import type { RuntimeEventV1 } from "../../events/types.ts";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("agent tape parse", () => {
  it("loads versioned fixtures", async () => {
    const tape = await loadAgentTape(path.join(fixturesDir, "text-only.json"));
    expect(tape.schema_version).toBe("xio-agent-tape.v1");
    expect(tape.name).toBe("text-only");
    expect(tape.turns).toHaveLength(1);
  });

  it("rejects unknown schema", () => {
    expect(() => parseAgentTape({ schema_version: "v0", name: "x", turns: [] })).toThrow(AgentTapeError);
  });
});

describe("ScriptedLlmClient", () => {
  it("drives pure text turn through agent loop", async () => {
    const tape = await loadAgentTape(path.join(fixturesDir, "text-only.json"));
    const client = createScriptedLlmClient({ tape });
    const host = new ExtensionHost();
    const result = await runAgentLoop("hi", { host, client, model: "scripted" });
    expect(result.finalText).toBe("hello");
    expect(result.success).toBe(true);
    expect(client.consumedTurns()).toBe(1);
  });

  it("drives tool-call turn without network", async () => {
    const tape = await loadAgentTape(path.join(fixturesDir, "tool-call.json"));
    const client = createScriptedLlmClient({ tape });
    const host = new ExtensionHost();
    host.registerTool(defineTool({
      name: "echo",
      description: "echo",
      parameters: Type.Object({ q: Type.String() }),
      async execute(_id, args) {
        return { content: [{ type: "text", text: `pong:${String(args.q)}` }] };
      },
    }));
    // Fixture golden expects content "pong" — match execute body for golden path below.
    const hostGolden = new ExtensionHost();
    hostGolden.registerTool(defineTool({
      name: "echo",
      description: "echo",
      parameters: Type.Object({ q: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "pong" }] };
      },
    }));
    const result = await runAgentLoop("use tool", { host, client, model: "scripted" });
    expect(result.finalText).toBe("tool done");
    expect(result.toolCalls).toBe(1);
    expect(client.consumedTurns()).toBe(2);

    // Separate golden run with stable tool body
    const client2 = createScriptedLlmClient({ tape });
    const bus = createRuntimeEventEmitter({
      sessionId: "golden-session",
      runId: "golden-run",
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });
    const events: RuntimeEventV1[] = [];
    bus.subscribe((event) => {
      events.push(event);
    });
    await runAgentLoop("use tool", {
      host: hostGolden,
      client: client2,
      model: "scripted",
      runtimeEvents: bus,
    });
    const normalized = normalizeRuntimeEventsForGolden(events);
    const goldenRaw = await readFile(
      path.join(fixturesDir, "goldens", "tool-call.events.json"),
      "utf8",
    );
    const golden = JSON.parse(goldenRaw) as unknown;
    expect(normalized).toEqual(golden);
  });

  it("surfaces tape error terminal", async () => {
    const tape = await loadAgentTape(path.join(fixturesDir, "error.json"));
    const client = createScriptedLlmClient({ tape });
    const host = new ExtensionHost();
    await expect(runAgentLoop("fail", { host, client, model: "scripted" })).rejects.toThrow(
      /simulated provider failure/,
    );
  });

  it("honors hang and barrier sequencing", async () => {
    const tape = await loadAgentTape(path.join(fixturesDir, "hang-barrier.json"));
    const seen: string[] = [];
    let releaseBarrier: (() => void) | undefined;
    const barrierGate = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const sleeps: number[] = [];
    const client = createScriptedLlmClient({
      tape,
      async onBarrier(id) {
        seen.push(id);
        if (id === "before-hang") {
          // Wait until test releases — proves barrier is awaitable.
          await barrierGate;
        }
      },
      async sleep(ms) {
        sleeps.push(ms);
      },
    });
    const host = new ExtensionHost();
    const pending = runAgentLoop("hang", { host, client, model: "scripted" });
    // Loop is parked on first barrier until we release.
    await new Promise<void>((r) => {
      setTimeout(r, 10);
    });
    expect(seen).toEqual(["before-hang"]);
    releaseBarrier?.();
    const result = await pending;
    expect(result.finalText).toBe("ok");
    expect(seen).toEqual(["before-hang", "after-hang"]);
    expect(sleeps).toEqual([50]);
    expect(client.barriersSeen()).toEqual(["before-hang", "after-hang"]);
  });

  it("locks event name order for text-only tape", async () => {
    const tape = await loadAgentTape(path.join(fixturesDir, "text-only.json"));
    const client = createScriptedLlmClient({ tape });
    const bus = createRuntimeEventEmitter({ sessionId: "s", runId: "r" });
    const events: RuntimeEventV1[] = [];
    bus.subscribe((e) => {
      events.push(e);
    });
    await runAgentLoop("hi", {
      host: new ExtensionHost(),
      client,
      model: "scripted",
      runtimeEvents: bus,
    });
    expect(runtimeEventNames(events)).toEqual([
      "run.start",
      "turn.start",
      "provider.request",
      "provider.first_token",
      "text.delta",
      "text.delta",
      "provider.done",
      "turn.end",
      "run.end",
    ]);
  });
});
