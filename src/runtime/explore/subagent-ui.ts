import type { ChatToolCall, ToolExecuteResult } from "../types.ts";
import type { ExploreRoleId } from "./roles.ts";

export type SubagentLifecycleMeta = Readonly<{
  workerId: number;
  modelLabel: string;
  role?: ExploreRoleId;
  goal: string;
  success?: boolean;
  status?: string;
}>;

export type SubagentUiSink = Readonly<{
  onLifecycle?: (phase: "start" | "end", meta: SubagentLifecycleMeta) => void;
  onThinkingDelta?: (text: string) => void;
  onAssistantDelta?: (text: string) => void;
  onAssistantText?: (text: string) => void;
  onToolStart?: (call: ChatToolCall) => void;
  onToolEnd?: (call: ChatToolCall, result: ToolExecuteResult) => void;
}>;

export type SubagentUiScope = Readonly<{
  workerId: number;
  role?: ExploreRoleId;
  modelLabel: string;
  sink: SubagentUiSink;
}>;

export type SubagentUiBridge = Readonly<{
  forWorker: (input: Readonly<{
    workerId: number;
    role?: ExploreRoleId;
    modelLabel: string;
    goal: string;
  }>) => SubagentUiSink;
}>;

export const noopSubagentUiSink: SubagentUiSink = {};

export const noopSubagentUiBridge: SubagentUiBridge = {
  forWorker: () => noopSubagentUiSink,
};

/** Prefix nested tool call ids so subagent tools never collide with primary agent pairing. */
export function scopeSubagentToolCall(workerId: number, call: ChatToolCall): ChatToolCall {
  const prefix = `w${workerId}:`;
  const rawId = call.id?.trim() ?? "";
  if (rawId.startsWith(prefix)) {
    return call;
  }
  return {
    ...call,
    id: rawId.length > 0 ? `${prefix}${rawId}` : `${prefix}anon`,
  };
}
