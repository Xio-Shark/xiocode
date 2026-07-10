import type { RunStore } from "./run-store.ts";
import type { RunMetadata, TodoItem } from "./types.ts";

export type RuntimeStatus = Readonly<{
  provider: string;
  model: string;
  runId: string;
  todo: TodoProgress;
}>;

export type TodoProgress = Readonly<{
  done: number;
  total: number;
  inProgress: number;
}>;

export async function collectRuntimeStatus(options: {
  runStore: RunStore;
  todos?: readonly TodoItem[];
  provider?: string;
  model?: string;
  currentRun?: RunMetadata;
}): Promise<RuntimeStatus> {
  const current = options.currentRun ?? (await options.runStore.listRecent(1))[0]?.metadata;
  return {
    provider: options.provider ?? current?.provider ?? "unknown",
    model: options.model ?? current?.model ?? "unknown",
    runId: current?.run_id ?? "none",
    todo: todoProgress(options.todos ?? []),
  };
}

export function formatStatusWidget(status: RuntimeStatus): readonly string[] {
  const todo = `${status.todo.done}/${status.todo.total}`;
  return [
    `XioCode ${status.provider}/${status.model}`,
    `Run ${status.runId}`,
    `TODO ${todo} active=${status.todo.inProgress}`,
  ];
}

export function todoProgress(todos: readonly TodoItem[]): TodoProgress {
  let done = 0;
  let inProgress = 0;
  for (const todo of todos) {
    if (todo.status === "done") {
      done++;
    } else if (todo.status === "in_progress") {
      inProgress++;
    }
  }
  return {
    done,
    inProgress,
    total: todos.length,
  };
}
