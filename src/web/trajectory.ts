/**
 * Trajectory extraction and analysis for XioCode Web Console.
 * Deeply aligned with DeepSeek Harness trajectory data models.
 */

import type { StoredSession } from "../runtime/session-store.ts";
import type { ChatMessage, ChatToolCall } from "../runtime/types.ts";

export type TrajectoryStep = Readonly<{
  id: string;
  stepNumber: number;
  turnNumber: number;
  type: "input" | "assistant" | "tool" | "thinking";
  role: "user" | "assistant" | "tool";
  name?: string;
  args?: Record<string, unknown>;
  argsPreview?: string;
  output?: string;
  outputPreview?: string;
  content?: string;
  thought?: string;
  isError?: boolean;
  callId?: string;
}>;

export type TrajectoryStats = Readonly<{
  totalTurns: number;
  totalSteps: number;
  totalToolCalls: number;
  totalErrors: number;
  model: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}>;

export type SessionTrajectory = Readonly<{
  id: string;
  stats: TrajectoryStats;
  steps: readonly TrajectoryStep[];
}>;

/**
 * Heuristically detect if a tool execution result represents a failure/error.
 */
export function isToolResultError(output?: string): boolean {
  if (!output) return false;
  const lower = output.toLowerCase();
  if (/exit_code=(?:[1-9][0-9]*|-1)/i.test(output)) return true;
  if (lower.includes("exit_code=1") || lower.includes("exit code 1") || lower.includes("exit code: 1")) return true;
  if (lower.startsWith("error:") || lower.includes("\nerror:") || lower.startsWith("err:")) return true;
  if (lower.includes("[tool_result error]")) return true;
  if (lower.includes("status=failed") || lower.includes("status: failed") || lower.includes("status=degraded") || lower.includes("status=error") || lower.includes("failed with code")) return true;
  if (lower.includes("command failed:") || lower.includes("fatal: ")) return true;
  return false;
}

/**
 * Format argument object to compact monospace preview.
 */
export function formatArgsPreview(args?: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) return "{}";
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.filePath === "string") return args.filePath;
  if (typeof args.query === "string") return args.query;

  try {
    const raw = JSON.stringify(args);
    return raw.length > 80 ? raw.slice(0, 77) + "..." : raw;
  } catch {
    return "{}";
  }
}

/**
 * Format output string to compact single-line preview.
 */
export function formatOutputPreview(output?: string): string {
  if (!output) return "(empty output)";
  const single = output.replace(/\s+/g, " ").trim();
  return single.length > 90 ? single.slice(0, 87) + "..." : single;
}

/**
 * Parse a StoredSession and reconstruct a clean, ordered list of TrajectorySteps.
 */
export function buildSessionTrajectory(session: StoredSession): SessionTrajectory {
  const steps: TrajectoryStep[] = [];
  const messages = session.messages || [];

  let turnNumber = 0;
  let stepNumber = 0;

  // Index tool results by toolCallId for fast pairing
  const toolResultsByCallId = new Map<string, { content: string; name?: string }>();
  const unlinkedToolResults: Array<{ name?: string; content: string; index: number }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "tool") {
      if (msg.toolCallId) {
        toolResultsByCallId.set(msg.toolCallId, { content: msg.content, name: msg.name });
      } else {
        unlinkedToolResults.push({ name: msg.name, content: msg.content, index: i });
      }
    }
  }

  let unlinkedToolIndex = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === "system") {
      continue;
    }

    if (msg.role === "user") {
      turnNumber++;
      stepNumber++;
      steps.push({
        id: `step-${stepNumber}-user`,
        stepNumber,
        turnNumber,
        type: "input",
        role: "user",
        content: msg.content,
      });
      continue;
    }

    if (msg.role === "assistant") {
      const thought = (msg as { thought?: string }).thought || (msg as { reasoning_content?: string }).reasoning_content;
      // 1. If thinking/thought process exists
      if (thought && thought.trim()) {
        stepNumber++;
        steps.push({
          id: `step-${stepNumber}-thought`,
          stepNumber,
          turnNumber: Math.max(1, turnNumber),
          type: "thinking",
          role: "assistant",
          thought: thought.trim(),
          content: thought.trim(),
        });
      }

      // 2. Assistant textual content
      const hasContent = Boolean(msg.content && msg.content.trim());
      const toolCalls = (msg.toolCalls ?? []) as readonly ChatToolCall[];
      const hasTools = toolCalls.length > 0;

      if (hasContent || !hasTools) {
        stepNumber++;
        steps.push({
          id: `step-${stepNumber}-assistant`,
          stepNumber,
          turnNumber: Math.max(1, turnNumber),
          type: "assistant",
          role: "assistant",
          content: hasContent ? msg.content.trim() : "(tool call only)",
        });
      } else if (!hasContent && hasTools) {
        // Explicitly record (tool call only) step to match DeepSeek Harness UI
        stepNumber++;
        steps.push({
          id: `step-${stepNumber}-assistant`,
          stepNumber,
          turnNumber: Math.max(1, turnNumber),
          type: "assistant",
          role: "assistant",
          content: "(tool call only)",
        });
      }

      // 3. Tool calls initiated by this assistant turn
      if (hasTools) {
        for (const tc of toolCalls) {
          stepNumber++;
          let matchedResult = tc.id ? toolResultsByCallId.get(tc.id) : undefined;
          if (!matchedResult && unlinkedToolIndex < unlinkedToolResults.length) {
            matchedResult = unlinkedToolResults[unlinkedToolIndex++];
          }

          const output = matchedResult?.content ?? "";
          const isError = isToolResultError(output);

          steps.push({
            id: `step-${stepNumber}-tool-${tc.id || tc.name}`,
            stepNumber,
            turnNumber: Math.max(1, turnNumber),
            type: "tool",
            role: "tool",
            name: tc.name,
            args: tc.arguments as Record<string, unknown>,
            argsPreview: formatArgsPreview(tc.arguments as Record<string, unknown>),
            output,
            outputPreview: formatOutputPreview(output),
            isError,
            callId: tc.id,
          });
        }
      }
      continue;
    }

    if (msg.role === "tool") {
      // If a tool message was not matched to any assistant toolCalls, surface it
      const alreadyPaired = steps.some(s => s.type === "tool" && s.callId === msg.toolCallId);
      if (!alreadyPaired && msg.content) {
        stepNumber++;
        const isError = isToolResultError(msg.content);
        steps.push({
          id: `step-${stepNumber}-tool-${msg.toolCallId || msg.name || "call"}`,
          stepNumber,
          turnNumber: Math.max(1, turnNumber),
          type: "tool",
          role: "tool",
          name: msg.name || "tool",
          output: msg.content,
          outputPreview: formatOutputPreview(msg.content),
          isError,
          callId: msg.toolCallId,
        });
      }
      continue;
    }
  }

  const totalToolCalls = steps.filter(s => s.type === "tool").length;
  const totalErrors = steps.filter(s => Boolean(s.isError)).length;
  const modelStr = `${session.metadata.model.provider}/${session.metadata.model.id}`;

  const stats: TrajectoryStats = {
    totalTurns: Math.max(1, turnNumber),
    totalSteps: steps.length,
    totalToolCalls,
    totalErrors,
    model: modelStr,
    cwd: session.metadata.cwd,
    createdAt: session.metadata.created_at,
    updatedAt: session.metadata.updated_at,
  };

  return {
    id: session.metadata.id,
    stats,
    steps,
  };
}
