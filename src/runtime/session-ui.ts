import { stdout as output } from "node:process";

import type { ChatToolCall, CommandUi, ContextCompactionUiEvent, ToolExecuteResult } from "./types.ts";

/** Default preview line count for tool output in TUI / stdout (OpenCode-like). */
export const TOOL_OUTPUT_PREVIEW_LINES = 8;

export type SessionUiSink = CommandUi & Readonly<{
  onAssistantDelta?: (text: string) => void;
  onAssistantText?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolStart?: (call: ChatToolCall) => void;
  onToolEnd?: (call: ChatToolCall, result: ToolExecuteResult) => void;
  onContextCompaction?: (event: ContextCompactionUiEvent) => void;
  onCancelled?: () => void;
  onDoneContract?: (summary: string) => void;
}>;

export function toolResultOutput(result: ToolExecuteResult): string {
  if (!result.content || result.content.length === 0) {
    return "";
  }
  return result.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("");
}

/**
 * Human-facing tool body for the TUI: peel bash's exit_code/stdout/stderr wrapper
 * so the transcript shows real command output instead of looking empty.
 */
export function formatToolOutputForDisplay(raw: string): string {
  if (raw.length === 0) return "";
  const bash = raw.match(/^exit_code=(-?\d+)\n\nstdout:\n([\s\S]*?)\n\nstderr:\n([\s\S]*)$/);
  if (bash) {
    const exitCode = bash[1] ?? "0";
    const stdout = (bash[2] ?? "").replace(/\n+$/, "");
    const stderr = (bash[3] ?? "").replace(/\n+$/, "");
    if (stdout.length > 0 && stderr.length > 0) {
      return `${stdout}\n--- stderr ---\n${stderr}`;
    }
    if (stdout.length > 0) return stdout;
    if (stderr.length > 0) return stderr;
    return exitCode === "0" ? "(ok, no output)" : `(exit ${exitCode}, no output)`;
  }
  return raw;
}

export function toolCallDetail(call: ChatToolCall): string {
  // Explore / subagent: surface the research goal first (not a raw JSON blob).
  if (call.name === "explore") {
    const goal = call.arguments.goal;
    if (typeof goal === "string" && goal.trim().length > 0) {
      const focus = call.arguments.focus_paths;
      const focusNote = Array.isArray(focus) && focus.length > 0
        ? ` · paths:${focus.filter((p): p is string => typeof p === "string").slice(0, 3).join(",")}`
        : "";
      return `${goal.trim()}${focusNote}`;
    }
  }
  const command = call.arguments.command;
  if (typeof command === "string" && command.length > 0) return command;
  const path = call.arguments.path ?? call.arguments.file_path;
  if (typeof path === "string" && path.length > 0) return path;
  return JSON.stringify(call.arguments);
}

/** True when the tool is the primary→worker explore fan-out. */
export function isExploreToolName(name: string | undefined): boolean {
  return (name ?? "").toLowerCase() === "explore";
}

/** Transcript title for explore tools so subagents are obvious in the UI. */
export function formatExploreToolLabel(options: Readonly<{
  running?: boolean;
  status?: "done" | "failed" | "…";
}> = {}): string {
  const status = options.status
    ?? (options.running === true ? "…" : undefined);
  const base = "subagent";
  return status ? `${base} ${status}` : base;
}

export function previewText(text: string, maxLines = TOOL_OUTPUT_PREVIEW_LINES): Readonly<{
  text: string;
  truncated: boolean;
}> {
  if (text.length === 0) return { text: "", truncated: false };
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: false };
  return {
    text: `${lines.slice(0, maxLines).join("\n")}\n… (${lines.length - maxLines} more lines)`,
    truncated: true,
  };
}

export function createStdoutSessionUiSink(write: (chunk: string) => void = (chunk) => output.write(chunk)): SessionUiSink {
  let streamed = false;
  let thinkingOpen = false;
  return {
    notify(message, level) {
      write(`${level ? `[${level}] ` : ""}${message}\n`);
    },
    setStatus(key, text) {
      if (text) write(`[status:${key}] ${text}\n`);
    },
    setWidget(_key, content) {
      if (content && content.length > 0) write(`${content.join("\n")}\n`);
    },
    onThinkingDelta(text) {
      if (!thinkingOpen) {
        write("\n[think] ");
        thinkingOpen = true;
      }
      write(text);
    },
    onAssistantDelta(text) {
      if (thinkingOpen) {
        write("\n[think collapsed]\n");
        thinkingOpen = false;
      }
      if (!streamed) {
        write("\n");
        streamed = true;
      }
      write(text);
    },
    onAssistantText(text) {
      if (thinkingOpen) {
        write("\n[think collapsed]\n");
        thinkingOpen = false;
      }
      if (!streamed) {
        write(`\n${text}\n`);
        return;
      }
      write("\n");
      streamed = false;
    },
    onToolStart(call) {
      if (isExploreToolName(call.name)) {
        write(`\n⊹ subagent … ${toolCallDetail(call)}\n`);
        return;
      }
      write(`\n> ${call.name}(${toolCallDetail(call)})\n`);
    },
    onToolEnd(call, result) {
      const outputText = toolResultOutput(result);
      const status = result.isError === true ? "failed" : "done";
      if (isExploreToolName(call.name)) {
        write(`⊹ subagent ${status} ${toolCallDetail(call)}\n`);
      } else {
        write(`${call.name} ${status}\n`);
      }
      if (outputText.length > 0) {
        const preview = previewText(outputText);
        write(`${preview.text}${preview.truncated ? " [truncated]" : ""}\n`);
      }
    },
    onContextCompaction(event) {
      if (event.stage === "start") {
        write("[context] compacting...\n");
        return;
      }
      if (event.stage === "success") {
        write(`[context] compacted ${event.before} -> ${event.after} messages\n`);
        return;
      }
      if (event.stage === "skip") {
        write("[context] already compact\n");
        return;
      }
      write(`[context:error] compaction failed: ${event.error}\n`);
    },
    onCancelled() {
      write("\n(cancelled)\n");
    },
    onDoneContract(summary) {
      write(`\n${summary}\n`);
    },
  };
}
