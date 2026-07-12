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
  return result.content.map((part) => part.text).join("");
}

export function toolCallDetail(call: ChatToolCall): string {
  const command = call.arguments.command;
  if (typeof command === "string" && command.length > 0) return command;
  return JSON.stringify(call.arguments);
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
      write(`\n> ${call.name}(${toolCallDetail(call)})\n`);
    },
    onToolEnd(call, result) {
      const outputText = toolResultOutput(result);
      const status = result.isError === true ? "failed" : "done";
      write(`${call.name} ${status}\n`);
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
