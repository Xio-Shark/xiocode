export { GoalStore } from "./goal-store.ts";
export { Verifier } from "./verifier.ts";
export { ExternalEvalAdapter } from "./external-eval-adapter.ts";
export type { ExternalEvalFailure } from "./external-eval-adapter.ts";
export { SelfImproveRunner } from "./self-improve-runner.ts";
export type { ApplyGoalFn, SelfImproveRunnerOptions } from "./self-improve-runner.ts";
export { createPrivateRegressionGate } from "./private-gate.ts";
export type { CreatePrivateRegressionGateOptions } from "./private-gate.ts";
export { BUILTIN_SEEDS } from "./seeds.ts";
export {
  failureSignature,
  goalFingerprint,
  ImprovementRunService,
  LedgerClaimError,
  RepeatedFailureStop,
} from "./run-ledger/service.ts";
export { RunLedgerStore, LedgerLockError, LedgerStoreError } from "./run-ledger/store.ts";
export { reduceTransition, replayPendingEvents, InvalidTransitionError } from "./run-ledger/reducer.ts";
export {
  FAILURE_SIGNATURE_STOP_AT,
  FAILURE_SIGNATURE_WARN_AT,
  LedgerDecodeError,
} from "./run-ledger/types.ts";
export type {
  ImprovementRunState,
  ImprovementRunEvent,
  RunContinuation,
  RunOutcome,
  RunPhase,
  TransitionInput,
  VerifierReceipt,
  MergeReceipt,
} from "./run-ledger/types.ts";
export type {
  CapabilityGate,
  CapabilityGateResult,
  CapabilityGateStatus,
  GoalSource,
  ImproveGoal,
  ImproveRunResult,
  MergeOutcome,
  PrivateGate,
  PrivateGateResult,
  PrivateGateStatus,
  ScriptedChange,
  VerifierResult,
} from "./types.ts";
