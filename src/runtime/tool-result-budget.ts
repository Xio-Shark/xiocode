import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChatMessage } from "./types.ts";

/** Default per-tool_result character budget before spill. */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 16_000;
/** Default number of newest tool rounds kept intact by microcompact. */
export const DEFAULT_MICROCOMPACT_KEEP_TOOL_ROUNDS = 4;
/** Max inline chars for tool_results older than the keep window. */
export const DEFAULT_MICROCOMPACT_OLDER_MAX_CHARS = 512;

const SPILL_MARKER = "[tool_result spilled:";
const MICRO_MARKER = "[tool_result truncated:";

export type ToolResultBudgetOptions = Readonly<{
  /** Max characters kept inline in the message. Default 16_000. */
  maxChars?: number;
  /**
   * Directory for spilled bodies (created if missing).
   * Prefer run dir `…/tool-results`; falls back to `~/.xiocode/spills` when omitted.
   */
  spillDir?: string;
  /** Clock for unique filenames in tests. */
  now?: () => number;
  /**
   * Keep the newest N assistant↔tool rounds intact; older tool bodies are
   * truncated in place (pairing preserved). Default 4; 0 disables microcompact.
   */
  keepToolRounds?: number;
  /** Max chars for tool bodies outside the keep window. Default 512. */
  olderMaxChars?: number;
}>;

export type ToolResultSpill = Readonly<{
  toolCallId: string;
  path: string;
  originalChars: number;
}>;

export type ApplyToolResultBudgetResult = Readonly<{
  messages: ChatMessage[];
  spills: readonly ToolResultSpill[];
}>;

/**
 * Spill oversized tool_result message bodies to disk and replace content with a
 * short stub that points at the absolute path. Preserves message order and
 * tool_use / tool_result id pairing.
 *
 * Idempotent for already-spilled stubs (content starting with the spill marker).
 * Optionally microcompacts older tool rounds after spill.
 */
export async function applyToolResultBudget(
  messages: readonly ChatMessage[],
  options: ToolResultBudgetOptions = {},
): Promise<ApplyToolResultBudgetResult> {
  const maxChars = normalizeMaxChars(options.maxChars);
  const spills: ToolResultSpill[] = [];
  let spillDirReady: string | undefined;
  let next: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role !== "tool") {
      next.push(message);
      continue;
    }
    const content = typeof message.content === "string" ? message.content : "";
    if (content.length <= maxChars || content.startsWith(SPILL_MARKER)) {
      next.push(message);
      continue;
    }

    if (!spillDirReady) {
      spillDirReady = await ensureSpillDir(options.spillDir);
    }
    const toolCallId = message.toolCallId ?? "unknown";
    const filePath = await spillToolResultBody({
      spillDir: spillDirReady,
      toolCallId,
      content,
      now: options.now,
    });
    spills.push({
      toolCallId,
      path: filePath,
      originalChars: content.length,
    });
    next.push({
      ...message,
      content: formatSpillStub(filePath, content.length),
    });
  }

  next = microcompactOldToolResults(next, {
    keepToolRounds: options.keepToolRounds,
    olderMaxChars: options.olderMaxChars,
  });

  return { messages: next, spills };
}

/**
 * Truncate tool_result bodies outside the newest N tool rounds.
 * Does not break assistant toolCalls ↔ tool message id pairing.
 */
export function microcompactOldToolResults(
  messages: readonly ChatMessage[],
  options: Readonly<{
    keepToolRounds?: number;
    olderMaxChars?: number;
  }> = {},
): ChatMessage[] {
  const keep = options.keepToolRounds ?? DEFAULT_MICROCOMPACT_KEEP_TOOL_ROUNDS;
  if (!Number.isInteger(keep) || keep <= 0) {
    return [...messages];
  }
  const olderMax = options.olderMaxChars ?? DEFAULT_MICROCOMPACT_OLDER_MAX_CHARS;
  if (!Number.isInteger(olderMax) || olderMax < 64) {
    throw new Error("olderMaxChars must be an integer >= 64");
  }

  const roundStarts = findToolRoundStarts(messages);
  if (roundStarts.length <= keep) {
    return [...messages];
  }
  const protectFrom = roundStarts[roundStarts.length - keep]!;
  return messages.map((message, index) => {
    if (index >= protectFrom || message.role !== "tool") return message;
    const content = typeof message.content === "string" ? message.content : "";
    if (content.length <= olderMax) return message;
    if (content.startsWith(SPILL_MARKER) || content.startsWith(MICRO_MARKER)) {
      // Already compact — keep spill path line only when longer than olderMax.
      if (content.length <= olderMax) return message;
      const firstLine = content.split("\n", 1)[0] ?? content;
      return {
        ...message,
        content: firstLine.length <= olderMax
          ? firstLine
          : `${MICRO_MARKER} ${content.length} chars]`,
      };
    }
    return {
      ...message,
      content: `${MICRO_MARKER} ${content.length} chars]\n${content.slice(0, Math.max(0, olderMax - 48))}…`,
    };
  });
}

/** Indices of assistant messages that open a tool round (have toolCalls). */
function findToolRoundStarts(messages: readonly ChatMessage[]): number[] {
  const starts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      starts.push(index);
    }
  }
  return starts;
}

/**
 * Mutate a messages array in place (same object identity for the array).
 * Used by the agent loop hot path.
 */
export async function applyToolResultBudgetInPlace(
  messages: ChatMessage[],
  options: ToolResultBudgetOptions = {},
): Promise<readonly ToolResultSpill[]> {
  const { messages: next, spills } = await applyToolResultBudget(messages, options);
  if (spills.length === 0) return spills;
  messages.splice(0, messages.length, ...next);
  return spills;
}

export function formatSpillStub(filePath: string, originalChars: number): string {
  return [
    `${SPILL_MARKER} ${filePath}]`,
    `Original length: ${originalChars} chars. Full body at the path above.`,
  ].join("\n");
}

function normalizeMaxChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TOOL_RESULT_MAX_CHARS;
  if (!Number.isInteger(value) || value < 256) {
    throw new Error("tool_result_max_chars must be an integer >= 256");
  }
  return value;
}

async function ensureSpillDir(explicit?: string): Promise<string> {
  const dir = explicit && explicit.trim().length > 0
    ? path.resolve(explicit)
    : path.join(os.homedir(), ".xiocode", "spills");
  await mkdir(dir, { recursive: true });
  return dir;
}

async function spillToolResultBody(input: Readonly<{
  spillDir: string;
  toolCallId: string;
  content: string;
  now?: () => number;
}>): Promise<string> {
  const safeId = input.toolCallId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "tool";
  const stamp = (input.now ?? Date.now)();
  const filePath = path.join(input.spillDir, `${safeId}-${stamp}.txt`);
  await writeFile(filePath, input.content, "utf8");
  return filePath;
}
