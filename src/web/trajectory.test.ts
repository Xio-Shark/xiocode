import { describe, it, expect } from "vitest";
import { buildSessionTrajectory, isToolResultError, formatArgsPreview, formatOutputPreview } from "./trajectory.ts";
import type { StoredSession } from "../runtime/session-store.ts";

describe("Trajectory Module", () => {
  it("detects tool errors accurately", () => {
    expect(isToolResultError("exit_code=0\nall good")).toBe(false);
    expect(isToolResultError("exit_code=1\ncommand not found")).toBe(true);
    expect(isToolResultError("exit_code=127\nbash error")).toBe(true);
    expect(isToolResultError("Error: cannot read file")).toBe(true);
    expect(isToolResultError("[tool_result error] failed")).toBe(true);
    expect(isToolResultError("backend=local status=degraded")).toBe(true);
    expect(isToolResultError("file created successfully")).toBe(false);
  });

  it("formats preview strings with truncation", () => {
    expect(formatArgsPreview(undefined)).toBe("{}");
    expect(formatArgsPreview({ cmd: "ls" })).toBe('{"cmd":"ls"}');
    expect(formatOutputPreview("")).toBe("(empty output)");
    expect(formatOutputPreview("  multi \n line \t output  ")).toBe("multi line output");
  });

  it("builds structured trajectory from session messages", () => {
    const mockSession: StoredSession = {
      metadata: {
        schema_version: "xio-session.v2",
        revision: 1,
        id: "test-session-123",
        model: { provider: "deepseek", id: "deepseek-v4-flash" },
        cwd: "/workspace/demo-project",
        main_root: "/workspace/demo-project",
        created_at: "2026-08-27T07:00:00.000Z",
        updated_at: "2026-08-27T07:05:00.000Z",
        workspace: {
          mode: "main",
          lifecycle: "active",
          main_root: "/workspace/demo-project",
          epoch: 0,
        },
        execution: {
          phase: "idle",
        },
      },
      messages: [
        { role: "system", content: "You are XioCode." },
        { role: "user", content: "Check git status and files" },
        {
          role: "assistant",
          content: "Let me check git status first.",
          thought: "User wants to inspect the repo. Running bash git status.",
          toolCalls: [
            {
              id: "call-001",
              name: "bash",
              arguments: { command: "git status" },
            },
          ],
        } as unknown as import("../runtime/types.ts").ChatMessage,
        {
          role: "tool",
          name: "bash",
          toolCallId: "call-001",
          content: "On branch main\nnothing to commit, working tree clean\nexit_code=0",
        },
        {
          role: "assistant",
          content: "", // tool call only
          toolCalls: [
            {
              id: "call-002",
              name: "view_file",
              arguments: { path: "package.json" },
            },
          ],
        },
        {
          role: "tool",
          name: "view_file",
          toolCallId: "call-002",
          content: "exit_code=1\nError: file not found",
        },
        {
          role: "assistant",
          content: "The git status is clean, but package.json was not found.",
        },
      ],
    };

    const result = buildSessionTrajectory(mockSession);

    expect(result.id).toBe("test-session-123");
    expect(result.stats.totalTurns).toBe(1);
    expect(result.stats.totalToolCalls).toBe(2);
    expect(result.stats.totalErrors).toBe(1);
    expect(result.stats.model).toBe("deepseek/deepseek-v4-flash");

    // Check step sequence
    const types = result.steps.map(s => s.type);
    expect(types).toEqual([
      "input",       // user prompt
      "thinking",    // thought
      "assistant",   // assistant text
      "tool",        // bash
      "assistant",   // (tool call only)
      "tool",        // view_file (with error)
      "assistant",   // final answer
    ]);

    // Check (tool call only) step
    const toolCallOnlyStep = result.steps.find(s => s.content === "(tool call only)");
    expect(toolCallOnlyStep).toBeDefined();

    // Check error step
    const errStep = result.steps.find(s => s.name === "view_file");
    expect(errStep).toBeDefined();
    expect(errStep?.isError).toBe(true);

    // Check clean step
    const cleanStep = result.steps.find(s => s.name === "bash");
    expect(cleanStep).toBeDefined();
    expect(cleanStep?.isError).toBe(false);
  });
});
