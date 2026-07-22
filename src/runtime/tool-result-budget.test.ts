import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyToolResultBudget,
  applyToolResultBudgetInPlace,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  formatSpillStub,
} from "./tool-result-budget.ts";
import type { ChatMessage } from "./types.ts";

describe("tool-result-budget", () => {
  let root = "";

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("leaves under-budget tool results unchanged", async () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read", arguments: {} }] },
      { role: "tool", toolCallId: "1", name: "read", content: "small" },
    ];
    const result = await applyToolResultBudget(messages, { maxChars: 256 });
    expect(result.spills).toEqual([]);
    expect(result.messages).toEqual(messages);
  });

  it("spills oversized tool_result and keeps id pairing", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "xio-spill-"));
    const big = "x".repeat(500);
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "bash", arguments: { command: "cat" } },
          { id: "c2", name: "read", arguments: { path: "a" } },
        ],
      },
      { role: "tool", toolCallId: "c1", name: "bash", content: big },
      { role: "tool", toolCallId: "c2", name: "read", content: "tiny" },
    ];

    const result = await applyToolResultBudget(messages, {
      maxChars: 256,
      spillDir: root,
      now: () => 42,
    });

    expect(result.spills).toHaveLength(1);
    expect(result.spills[0]!.toolCallId).toBe("c1");
    expect(result.spills[0]!.originalChars).toBe(500);

    const spilled = result.messages[1]!;
    expect(spilled.role).toBe("tool");
    expect(spilled.toolCallId).toBe("c1");
    expect(spilled.content).toContain(result.spills[0]!.path);
    expect(spilled.content).toContain("Original length: 500");

    const onDisk = await readFile(result.spills[0]!.path, "utf8");
    expect(onDisk).toBe(big);

    expect(result.messages[2]).toEqual(messages[2]);
    expect(result.messages[0]?.toolCalls?.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("is idempotent for already-spilled stubs", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "xio-spill-"));
    const stub = formatSpillStub(path.join(root, "already.txt"), 9999);
    const messages: ChatMessage[] = [
      { role: "tool", toolCallId: "x", name: "bash", content: stub },
    ];
    const result = await applyToolResultBudget(messages, { maxChars: 256, spillDir: root });
    expect(result.spills).toEqual([]);
    expect(result.messages[0]?.content).toBe(stub);
  });

  it("applyToolResultBudgetInPlace mutates the array", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "xio-spill-"));
    const messages: ChatMessage[] = [
      { role: "tool", toolCallId: "z", name: "bash", content: "y".repeat(400) },
    ];
    const spills = await applyToolResultBudgetInPlace(messages, {
      maxChars: 256,
      spillDir: root,
      now: () => 7,
    });
    expect(spills).toHaveLength(1);
    expect(messages[0]!.content).toContain("[tool_result spilled:");
  });

  it("defaults max chars to 16_000", () => {
    expect(DEFAULT_TOOL_RESULT_MAX_CHARS).toBe(16_000);
  });

  it("microcompacts older tool rounds while preserving pairing", async () => {
    const { microcompactOldToolResults } = await import("./tool-result-budget.ts");
    const messages: ChatMessage[] = [];
    for (let round = 1; round <= 3; round += 1) {
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id: `r${round}`, name: "bash", arguments: { n: round } }],
      });
      messages.push({
        role: "tool",
        toolCallId: `r${round}`,
        name: "bash",
        content: `body-${round}-` + "x".repeat(200),
      });
    }
    const compacted = microcompactOldToolResults(messages, {
      keepToolRounds: 1,
      olderMaxChars: 80,
    });
    expect(compacted[1]!.toolCallId).toBe("r1");
    expect(compacted[1]!.content).toContain("[tool_result truncated:");
    expect(compacted[3]!.toolCallId).toBe("r2");
    expect(compacted[3]!.content).toContain("[tool_result truncated:");
    expect(compacted[5]!.toolCallId).toBe("r3");
    expect(compacted[5]!.content).toContain("body-3-");
    expect(compacted[0]!.toolCalls?.[0]?.id).toBe("r1");
    expect(compacted[4]!.toolCalls?.[0]?.id).toBe("r3");
  });
});
