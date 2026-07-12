import type { WorktreeSession } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";
import type { SessionExecution, SessionWorkspace, StoredSession } from "./session-store.ts";
import type { ChatMessage } from "./types.ts";

export const SESSION_RECOVERY_NAME = "xiocode_session_recovery";

export type RecoveredSession = Readonly<{
  messages: readonly ChatMessage[];
  workspace?: SessionWorkspace;
  execution?: SessionExecution;
  interruptedTools: number;
  filesRecoverable: boolean;
}>;

export function recoverStoredSession(stored: StoredSession | undefined, now = new Date()): RecoveredSession | undefined {
  if (!stored) return undefined;
  const workspace = stored.workspace;
  const execution = stored.execution;
  if (stored.metadata.schema_version === "xio-session.v1") {
    return {
      messages: [...stored.messages, {
        role: "system",
        name: SESSION_RECOVERY_NAME,
        content: "Recovered legacy chat only; v1 sessions do not contain enough worktree identity to recover prior files.",
      }],
      interruptedTools: 0,
      filesRecoverable: false,
    };
  }
  const filesRecoverable = workspace?.mode === "worktree"
    && (workspace.lifecycle === "active" || workspace.lifecycle === "retained");
  if (!execution || execution.phase === "idle") {
    const messages = workspace?.mode === "worktree" && !filesRecoverable
      ? [...stored.messages, {
          role: "system" as const,
          name: SESSION_RECOVERY_NAME,
          content: "Recovered chat only; the previous worktree was already finalized, so a new isolated worktree was created.",
        }]
      : stored.messages;
    return { messages, workspace, execution, interruptedTools: 0, filesRecoverable };
  }

  const pendingIds = new Set(execution.pending_tools?.map((tool) => tool.id) ?? []);
  const pending = stored.messages.flatMap((message, index) => message.role === "assistant"
    ? (message.toolCalls ?? []).filter((call) => {
        if (pendingIds.size > 0 && !pendingIds.has(call.id)) return false;
        return !stored.messages.slice(index + 1).some((candidate) =>
          candidate.role === "tool" && candidate.toolCallId === call.id
        );
      })
    : []);
  const repaired: ChatMessage[] = [...stored.messages];
  for (const call of pending) {
    repaired.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: `tool interrupted: completion unknown for ${call.name}; inspect workspace state before retrying`,
    });
  }
  repaired.push({
    role: "system",
    name: SESSION_RECOVERY_NAME,
    content: filesRecoverable
      ? `Recovered interrupted session state. ${pending.length} tool call(s) had unknown completion.`
      : `Recovered chat only. ${pending.length} tool call(s) had unknown completion; prior file state is unavailable.`,
  });
  return {
    messages: repaired,
    workspace,
    execution: {
      phase: "idle",
      ...(execution.checkpoint ? { checkpoint: execution.checkpoint } : {}),
      interrupted_at: now.toISOString(),
    },
    interruptedTools: pending.length,
    filesRecoverable,
  };
}

export function toWorktreeSession(workspace: SessionWorkspace | undefined): WorktreeSession | undefined {
  if (!workspace || workspace.mode !== "worktree") return undefined;
  if (workspace.lifecycle !== "active" && workspace.lifecycle !== "retained") return undefined;
  const required = {
    mainRoot: workspace.main_root,
    worktreePath: workspace.worktree_path,
    branch: workspace.branch,
    sessionId: workspace.session_id,
    repoId: workspace.repo_id,
    baseRef: workspace.base_ref,
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value) throw new Error(`saved session worktree is missing ${key}`);
  }
  return required as WorktreeSession;
}
