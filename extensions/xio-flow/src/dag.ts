import type { FlowTask, ReadyWave } from "./types.ts";

/**
 * Calculates which tasks are ready to run in the current wave,
 * and which tasks are blocked by failed dependencies.
 */
export function readyWave(
  tasks: readonly FlowTask[],
  succeeded: ReadonlySet<string>,
  failed: ReadonlySet<string>,
): ReadyWave {
  const ready: string[] = [];
  const blocked: string[] = [];
  const finished = new Set([...succeeded, ...failed]);

  for (const task of tasks) {
    if (finished.has(task.id)) continue;
    const deps = task.depends_on ?? [];
    if (deps.some((dep) => failed.has(dep))) {
      blocked.push(task.id);
      continue;
    }
    if (deps.every((dep) => succeeded.has(dep))) {
      ready.push(task.id);
    }
  }

  return { ready, blocked };
}

/**
 * Performs topological sort over the tasks.
 * Throws an Error if a circular dependency is detected.
 */
export function topoSort(tasks: readonly FlowTask[]): string[] {
  const taskMap = new Map<string, FlowTask>();
  for (const t of tasks) {
    if (taskMap.has(t.id)) {
      throw new Error(`Duplicate task ID: "${t.id}"`);
    }
    taskMap.set(t.id, t);
  }

  // Validate that all depends_on references exist
  for (const t of tasks) {
    for (const dep of t.depends_on ?? []) {
      if (!taskMap.has(dep)) {
        throw new Error(`Task "${t.id}" depends on unknown task "${dep}"`);
      }
    }
  }

  const succeeded = new Set<string>();
  const order: string[] = [];
  const remaining = new Set(tasks.map((t) => t.id));

  while (remaining.size > 0) {
    const { ready } = readyWave(tasks, succeeded, new Set());
    const next = ready.filter((id) => remaining.has(id));

    if (next.length === 0) {
      const cycleCandidates = [...remaining].join(", ");
      throw new Error(`Circular dependency detected involving task(s): ${cycleCandidates}`);
    }

    for (const id of next) {
      remaining.delete(id);
      succeeded.add(id);
      order.push(id);
    }
  }

  return order;
}

/**
 * Partitions tasks into sequential waves of concurrent task batches.
 * Tasks within each wave can be executed in parallel.
 */
export function partitionWaves(tasks: readonly FlowTask[]): (readonly string[])[] {
  // Ensure valid DAG first
  topoSort(tasks);

  const waves: string[][] = [];
  const succeeded = new Set<string>();
  const remaining = new Set(tasks.map((t) => t.id));

  while (remaining.size > 0) {
    const { ready } = readyWave(tasks, succeeded, new Set());
    const currentWave = ready.filter((id) => remaining.has(id));
    if (currentWave.length === 0) break;

    waves.push(currentWave);
    for (const id of currentWave) {
      remaining.delete(id);
      succeeded.add(id);
    }
  }

  return waves;
}
