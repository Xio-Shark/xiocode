import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { registerXioEvolve } from "../../../extensions/xio-evolve/src/index.ts";
import { RunStore } from "../../../extensions/xio-evolve/src/run-store.ts";
import { TrajectoryRecorder } from "../../../extensions/xio-evolve/src/trajectory-recorder.ts";
import { prepareSession } from "../session.ts";
import { createScriptedLlmClient, loadAgentTape } from "../providers/scripted/index.ts";
import { parseNdjsonRuntimeEvents } from "./stream-json.ts";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "./types.ts";

import type { XioRuntimeConfig } from "../../cli/config-parser.ts";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../providers/scripted/fixtures",
);

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function minimalRuntimeConfig(runRoot: string): XioRuntimeConfig {
  return {
    general: { runRoot, maxTurns: 8, defaultProvider: "scripted", defaultModel: "scripted" },
    providers: {
      scripted: {
        name: "scripted",
        kind: "openai",
        model: "scripted",
        apiKeyEnv: "XIO_TEST_KEY",
      },
    },
    worktree: { enabled: false, retainOnReject: false, allowDirty: false },
    extensions: { evolve: { enabled: true, options: {} } },
    verify: { enabled: false, requireAllPass: true, repairTurns: 0, commands: [] },
    agentsMd: { enabled: false, readClaudeDirs: false, maxBytes: 1, maxImportDepth: 1 },
    skills: { enabled: false, readClaude: false, readCursor: false, maxBodyBytes: 1 },
    hooks: { enabled: false, readClaude: false, timeoutMs: 1 },
    mcp: {
      enabled: false,
      readClaude: false,
      readCursor: false,
      failClosed: false,
      unknownSourceFailClosed: false,
      timeoutMs: 1,
      servers: {},
    },
    permissions: { allowHighRisk: false },
    explore: {
      enabled: false,
      maxTurns: 4,
      timeoutMs: 1_000,
      maxConcurrency: 1,
      maxOutputChars: 1_000,
      allowBash: false,
      maxTokens: 1_000,
      maxCostUsd: 1,
      maxStartsPerMinute: 1,
    },
    retrospective: {
      enabled: false,
      skipTrivial: true,
      minToolCalls: 1,
      autoInject: false,
      enqueueImprove: false,
      useLlm: false,
    },
    regress: { offerOnFailure: false },
  };
}

describe("prepareSession product RuntimeEvent sinks", () => {
  it("stream-json stdout + evolve trajectory share one bus", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-product-sinks-"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const store = new RunStore({ root: tempDir });
    const recorder = new TrajectoryRecorder({ store });

    const tape = await loadAgentTape(path.join(fixturesDir, "text-only.json"));
    const session = await prepareSession({
      cwd: tempDir,
      workspaceRoot: tempDir,
      runtimeConfig: minimalRuntimeConfig(tempDir),
      outputFormat: "stream-json",
      sessionId: "sess-product",
      streamJsonWrite: (chunk) => {
        stdout.push(chunk);
      },
      streamJsonStderr: (chunk) => {
        stderr.push(chunk);
      },
      llmClient: createScriptedLlmClient({ tape }),
      model: { provider: "scripted", id: "scripted" },
      env: { ...process.env, XIO_TEST_KEY: "test" },
      ask: async () => true,
      registerExtensions: (api) => {
        registerXioEvolve({
          on: (event, handler) => {
            api.on(event, handler);
          },
          getRuntimeEvents: () => api.getRuntimeEvents?.(),
          registerCommand: (name, options) => {
            api.registerCommand(name, options);
          },
        }, { trajectoryRecorder: recorder, runStore: store });
      },
    });

    expect(session.host.getRuntimeEvents()).toBeDefined();

    const result = await session.runPrompt("hi");
    await session.close();

    const joined = stdout.join("");
    expect(joined.includes("> ")).toBe(false);
    expect(joined.includes("[think]")).toBe(false);
    const events = parseNdjsonRuntimeEvents(joined);
    expect(events.length).toBeGreaterThan(2);
    expect(events.every((event) => event.schema_version === RUNTIME_EVENT_SCHEMA_VERSION)).toBe(true);
    expect(events.some((event) => event.event === "text.delta")).toBe(true);
    expect(events.some((event) => event.event === "turn.end")).toBe(true);
    expect(result.success).toBe(true);
    expect(result.cancelled).not.toBe(true);

    // Trajectory filled via RuntimeEvent bus (product sink B alongside stream-json).
    const recent = await store.listRecent(1);
    expect(recent[0]).toBeDefined();
    const trajectory = await recorder.readTrajectory(recent[0]!.run_id) as {
      messages?: unknown[];
    };
    expect(Array.isArray(trajectory.messages)).toBe(true);
    expect((trajectory.messages?.length ?? 0)).toBeGreaterThan(0);

    // Workspace/status diagnostics used the stderr sink during prepareSession.
    expect(stderr.join("").length).toBeGreaterThan(0);
    expect(joined).not.toContain("workspace:");
  });
});
