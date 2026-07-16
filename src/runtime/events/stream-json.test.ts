import { describe, expect, it } from "vitest";

import { ExtensionHost } from "../extension-host.ts";
import { defineTool } from "../define-tool.ts";
import { Type } from "../schema.ts";
import { runAgentLoop } from "../agent-loop.ts";
import { createScriptedLlmClient, loadAgentTape } from "../providers/scripted/index.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRuntimeEventEmitter } from "./emitter.ts";
import {
  createStreamJsonSessionUiSink,
  parseNdjsonRuntimeEvents,
  pipeRuntimeEventsToStreamJson,
} from "./stream-json.ts";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "./types.ts";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../providers/scripted/fixtures",
);

describe("stream-json NDJSON sink", () => {
  it("writes only RuntimeEvent lines from a scripted agent loop", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const bus = createRuntimeEventEmitter({
      sessionId: "sess-json",
      runId: "run-json",
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    });
    pipeRuntimeEventsToStreamJson(bus, (chunk) => {
      stdout.push(chunk);
    });
    const sink = createStreamJsonSessionUiSink((chunk) => {
      stderr.push(chunk);
    });
    sink.notify?.("diag only", "info");

    const tape = await loadAgentTape(path.join(fixturesDir, "text-only.json"));
    const client = createScriptedLlmClient({ tape });
    await runAgentLoop("hi", {
      host: new ExtensionHost(),
      client,
      model: "scripted",
      runtimeEvents: bus,
      // Do not also wire human callbacks — stream-json is exclusive for stdout.
    });

    const joined = stdout.join("");
    expect(joined.includes("\n[think]")).toBe(false);
    expect(joined.includes("> ")).toBe(false);
    const events = parseNdjsonRuntimeEvents(joined);
    expect(events.length).toBeGreaterThan(3);
    expect(events.every((event) => event.schema_version === RUNTIME_EVENT_SCHEMA_VERSION)).toBe(true);
    expect(events[0]?.event).toBe("run.start");
    expect(events.at(-1)?.event).toBe("run.end");
    expect(events.some((event) => event.event === "text.delta")).toBe(true);
    // Diagnostics only on stderr sink
    expect(stderr.join("")).toContain("diag only");
    expect(joined).not.toContain("diag only");
  });

  it("tool path produces tool.* events on NDJSON stdout only", async () => {
    const stdout: string[] = [];
    const bus = createRuntimeEventEmitter({ sessionId: "s", runId: "r" });
    pipeRuntimeEventsToStreamJson(bus, (chunk) => {
      stdout.push(chunk);
    });
    const host = new ExtensionHost();
    host.registerTool(defineTool({
      name: "echo",
      description: "echo",
      parameters: Type.Object({ q: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "pong" }] };
      },
    }));
    const tape = await loadAgentTape(path.join(fixturesDir, "tool-call.json"));
    await runAgentLoop("use tool", {
      host,
      client: createScriptedLlmClient({ tape }),
      model: "scripted",
      runtimeEvents: bus,
    });
    const events = parseNdjsonRuntimeEvents(stdout.join(""));
    const names = events.map((event) => event.event);
    expect(names).toContain("tool.call");
    expect(names).toContain("tool.result");
    expect(names).toContain("turn.end");
  });
});
