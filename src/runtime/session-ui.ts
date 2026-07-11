import { stdout as output } from "node:process";

import type { ChatToolCall, CommandUi, ToolExecuteResult } from "./types.ts";

export type SessionUiSink = CommandUi & Readonly<{
  onAssistantDelta?: (text: string) => void;
  onAssistantText?: (text: string) => void;
  onToolStart?: (call: ChatToolCall) => void;
  onToolEnd?: (call: ChatToolCall, result: ToolExecuteResult) => void;
  onCancelled?: () => void;
  onDoneContract?: (summary: string) => void;
}>;

export function createStdoutSessionUiSink(write: (chunk: string) => void = (chunk) => output.write(chunk)): SessionUiSink {
  let streamed = false;
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
    onAssistantDelta(text) {
      if (!streamed) {
        write("\n");
        streamed = true;
      }
      write(text);
    },
    onAssistantText(text) {
      if (!streamed) {
        write(`\n${text}\n`);
        return;
      }
      write("\n");
      streamed = false;
    },
    onToolStart(call) {
      write(`\n> ${call.name}(${JSON.stringify(call.arguments)})\n`);
    },
    onCancelled() {
      write("\n(cancelled)\n");
    },
    onDoneContract(summary) {
      write(`\n${summary}\n`);
    },
  };
}
