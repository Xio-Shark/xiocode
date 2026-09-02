import { partitionWaves, topoSort } from "./dag.ts";
import type { FlowConfig, FlowTask, FlowValidationResult, ScopeConflict } from "./types.ts";

export function normalizePattern(pattern: string): string {
  return pattern
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * Checks if two write scope glob patterns could match the same file/directory.
 */
export function patternsOverlap(patternA: string, patternB: string): boolean {
  const normA = normalizePattern(patternA);
  const normB = normalizePattern(patternB);

  if (normA.length === 0 || normB.length === 0) return false;
  if (normA === "**" || normB === "**") return true;
  if (normA === normB) return true;

  const prefixA = normA.endsWith("/**") ? normA.slice(0, -3) : normA.replace(/\/\*+$/, "");
  const prefixB = normB.endsWith("/**") ? normB.slice(0, -3) : normB.replace(/\/\*+$/, "");

  // If one is a directory ancestor of the other
  if (normA.endsWith("/**") || normA.endsWith("/*")) {
    if (normB.startsWith(prefixA + "/") || normB === prefixA) return true;
  }
  if (normB.endsWith("/**") || normB.endsWith("/*")) {
    if (normA.startsWith(prefixB + "/") || normA === prefixB) return true;
  }

  // Exact directory match
  if (prefixA === prefixB) return true;

  return false;
}

/**
 * Checks if two tasks' write scopes have any overlapping patterns.
 */
export function scopesOverlap(
  scopeA: readonly string[] | undefined,
  scopeB: readonly string[] | undefined,
): { overlap: boolean; patternA?: string; patternB?: string } {
  if (!scopeA || !scopeB || scopeA.length === 0 || scopeB.length === 0) {
    return { overlap: false };
  }

  for (const a of scopeA) {
    for (const b of scopeB) {
      if (patternsOverlap(a, b)) {
        return { overlap: true, patternA: a, patternB: b };
      }
    }
  }

  return { overlap: false };
}

/**
 * Detects write scope conflicts among tasks that can run in the same concurrent wave.
 */
export function detectScopeConflicts(
  tasks: readonly FlowTask[],
  waves: readonly (readonly string[])[],
): ScopeConflict[] {
  const taskMap = new Map<string, FlowTask>(tasks.map((t) => [t.id, t]));
  const conflicts: ScopeConflict[] = [];

  for (const wave of waves) {
    if (wave.length <= 1) continue;

    for (let i = 0; i < wave.length; i++) {
      for (let j = i + 1; j < wave.length; j++) {
        const taskA = taskMap.get(wave[i]!);
        const taskB = taskMap.get(wave[j]!);
        if (!taskA || !taskB) continue;

        const { overlap, patternA, patternB } = scopesOverlap(taskA.write_scope, taskB.write_scope);
        if (overlap && patternA && patternB) {
          conflicts.push({
            taskA: taskA.id,
            taskB: taskB.id,
            patternA,
            patternB,
            reason: `Concurrent tasks "${taskA.id}" and "${taskB.id}" in the same wave have overlapping write_scope: "${patternA}" <-> "${patternB}"`,
          });
        }
      }
    }
  }

  return conflicts;
}

/**
 * Complete validator for a Flow configuration.
 */
export function validateFlow(config: FlowConfig): FlowValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.tasks || config.tasks.length === 0) {
    return {
      valid: false,
      errors: ["Flow configuration has no tasks defined"],
      warnings: [],
    };
  }

  let sortedOrder: string[] | undefined;
  let waves: (readonly string[])[] | undefined;

  try {
    sortedOrder = topoSort(config.tasks);
    waves = partitionWaves(config.tasks);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return {
      valid: false,
      errors,
      warnings,
    };
  }

  const scopeConflicts = detectScopeConflicts(config.tasks, waves);
  if (scopeConflicts.length > 0) {
    for (const conflict of scopeConflicts) {
      warnings.push(conflict.reason);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    sortedOrder,
    waves,
    scopeConflicts,
  };
}
