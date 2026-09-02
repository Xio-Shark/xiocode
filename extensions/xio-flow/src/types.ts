export type FlowTask = Readonly<{
  id: string;
  name?: string;
  description?: string;
  depends_on?: readonly string[];
  write_scope?: readonly string[];
  command?: string;
  timeout_sec?: number;
}>;

export type FlowConfig = Readonly<{
  version: "1.0" | "1";
  name?: string;
  max_concurrency?: number;
  tasks: readonly FlowTask[];
}>;

export type ReadyWave = Readonly<{
  ready: readonly string[];
  blocked: readonly string[];
}>;

export type ScopeConflict = Readonly<{
  taskA: string;
  taskB: string;
  patternA: string;
  patternB: string;
  reason: string;
}>;

export type FlowValidationResult = Readonly<{
  valid: boolean;
  errors: readonly string[];
  warnings: readonly string[];
  sortedOrder?: readonly string[];
  waves?: readonly (readonly string[])[];
  scopeConflicts?: readonly ScopeConflict[];
}>;
