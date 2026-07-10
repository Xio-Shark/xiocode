/** Goal source buckets for T4 scheduling: queue → red_test → seed. */
export type GoalSource = "queue" | "red_test" | "seed" | "external_eval";

export type ScriptedChange = Readonly<{
  /** Path relative to worktree / main root. */
  path: string;
  content: string;
}>;

export type ImproveGoal = Readonly<{
  id: string;
  source: GoalSource;
  title: string;
  /** Prompt passed to xio when no scriptedChange is present. */
  prompt: string;
  /** Optional deterministic patch for seeds / tests (no LLM). */
  scriptedChange?: ScriptedChange;
  /** Optional metadata (e.g. external eval instance id). */
  meta?: Readonly<Record<string, string>>;
}>;

export type VerifierResult = Readonly<{
  ok: boolean;
  commands: readonly string[];
  output: string;
  exitCode: number;
}>;

export type CapabilityGateStatus = "PASS" | "PASS_WITH_CONCERNS" | "FAIL" | "INFRA_ERROR";

export type CapabilityGateResult = Readonly<{
  status: CapabilityGateStatus;
  evalId?: string;
  concerns: readonly string[];
  errors: readonly string[];
}>;

export type CapabilityGate = Readonly<{
  evaluate: (input: Readonly<{
    mainRoot: string;
    candidateRoot: string;
    goal: ImproveGoal;
  }>) => Promise<CapabilityGateResult>;
}>;

export type MergeOutcome =
  | Readonly<{
    asked: false;
    reason: "verifier_red" | "no_changes" | "skipped_by_policy"
      | "capability_gate_fail" | "capability_gate_concerns" | "capability_gate_infra";
  }>
  | Readonly<{ asked: true; approved: false }>
  | Readonly<{ asked: true; approved: true; merged: true; summary: string }>
  | Readonly<{ asked: true; approved: true; merged: false; error: string; conflict: boolean }>;

export type ImproveRunResult = Readonly<{
  goal: ImproveGoal;
  worktreePath: string;
  verifier: VerifierResult;
  capabilityGate?: CapabilityGateResult;
  merge: MergeOutcome;
}>;
