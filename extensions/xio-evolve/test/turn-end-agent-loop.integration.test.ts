import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExtensionHost } from "../../../src/runtime/extension-host.ts";
import { defineTool } from "../../../src/runtime/define-tool.ts";
import { Type } from "../../../src/runtime/schema.ts";
import { runAgentLoop } from "../../../src/runtime/agent-loop.ts";
import { RunStore } from "../src/run-store.ts";
import { TrajectoryRecorder } from "../src/trajectory-recorder.ts";

import type { LlmClient, TurnEndPayload } from "../../../src/runtime/types.ts";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

/**
 * Integration: real agent loop → trajectory recorder (same hook wiring as xio-evolve).
 * Locks the turn_end contract so prompt-only payloads fail closed.
 */
describe("agent loop → trajectory turn_end contract", () => {
  it("records non-zero turn_index, message, and toolResults from live loop payloads", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-turn-end-"));
    const store = new RunStore({ root: tempDir });
    const recorder = new TrajectoryRecorder({ store });
    await recorder.start({ run_id: "run-live-turn" });

    const host = new ExtensionHost();
    host.registerTool(defineTool({
      name: "grep_stub",
      description: "grep",
      parameters: Type.Object({ pattern: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "match: turn_end" }] };
      },
    }));

    host.on("tool_call", async (payload) => {
      await recorder.recordToolCall(payload);
    });
    host.on("tool_result", async (payload) => {
      await recorder.recordToolResult(payload);
    });
    const livePayloads: TurnEndPayload[] = [];
    host.on("turn_end", (payload) => {
      livePayloads.push(payload as TurnEndPayload);
      recorder.recordTurnEnd(payload);
    });
    host.on("agent_end", async (payload) => {
      const event = payload as { success?: boolean; cancelled?: boolean };
      await recorder.finish(event.success === true && event.cancelled !== true ? "success" : "failed");
    });

    let calls = 0;
    const client: LlmClient = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [{ id: "g1", name: "grep_stub", arguments: { pattern: "turn_end" } }],
          };
        }
        return { content: "- [x] verify live trajectory", toolCalls: [] };
      },
    };

    await runAgentLoop("find turn_end", { host, client, model: "stub" });

    expect(livePayloads).toHaveLength(1);
    expect(livePayloads[0]).toMatchObject({
      turnIndex: 1,
      prompt: "find turn_end",
      message: { content: "- [x] verify live trajectory" },
      outcome: "success",
    });
    expect(livePayloads[0]!.toolResults).toEqual([
      expect.objectContaining({
        toolCallId: "g1",
        toolName: "grep_stub",
        content: "match: turn_end",
        isError: false,
      }),
    ]);

    const trajectory = await recorder.readTrajectory("run-live-turn") as Record<string, unknown>;
    expect(trajectory.finalMessage).toEqual({ content: "- [x] verify live trajectory" });
    expect(trajectory.todo_items).toEqual([{ text: "verify live trajectory", status: "done" }]);
    expect(Array.isArray(trajectory.tool_rounds)).toBe(true);
    expect((trajectory.tool_rounds as unknown[]).length).toBeGreaterThan(0);

    const summary = JSON.parse(
      await readFile(path.join(tempDir, "run-live-turn", "summary.json"), "utf8"),
    ) as { status: string; failure_reasons: string[] };
    expect(summary.status).toBe("success");
    expect(summary.failure_reasons).not.toContain("contract:turn_end_incomplete");
  });

  it("increments turn_index across two user prompts with priorMessages", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-turn-multi-"));
    const store = new RunStore({ root: tempDir });
    const recorder = new TrajectoryRecorder({ store });
    await recorder.start({ run_id: "run-multi" });

    const host = new ExtensionHost();
    const indices: number[] = [];
    host.on("turn_end", (payload) => {
      const turn = payload as TurnEndPayload;
      indices.push(turn.turnIndex);
      recorder.recordTurnEnd(payload);
    });
    host.on("agent_end", async () => {
      // finish only after second turn; first agent_end would close the run early
    });

    const client: LlmClient = {
      async complete() {
        return { content: "reply", toolCalls: [] };
      },
    };

    const first = await runAgentLoop("prompt-a", { host, client, model: "stub" });
    await runAgentLoop("prompt-b", {
      host,
      client,
      model: "stub",
      priorMessages: first.messages,
    });
    await recorder.finish("success");

    expect(indices).toEqual([1, 2]);
    const trajectory = await recorder.readTrajectory("run-multi") as Record<string, unknown>;
    expect(trajectory.messages).toEqual([
      { content: "reply" },
      { content: "reply" },
    ]);
  });

  it("marks incomplete turn_end payloads as contract failures", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "xio-turn-bad-"));
    const store = new RunStore({ root: tempDir });
    const recorder = new TrajectoryRecorder({ store });
    await recorder.start({ run_id: "run-bad" });

    // Old agent-loop shape
    recorder.recordTurnEnd({ prompt: "legacy only" });
    const summary = await recorder.finish();

    expect(summary.status).toBe("failed");
    expect(summary.failure_reasons).toContain("contract:turn_end_incomplete");
  });
});
