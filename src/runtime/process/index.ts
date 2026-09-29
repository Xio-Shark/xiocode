export {
  BoundedOutputCollector,
  OUTPUT_BUDGET_PRESETS,
  type CollectorSnapshot,
  type OutputBudget,
  type OutputChunkProjection,
  type OutputStreamName,
  type StreamCaptureSnapshot,
} from "./output-collector.ts";

export {
  createDeadlineSignal,
  forceKillProcessTree,
  runSupervisedProcess,
  type CleanupGuarantee,
  type KernelOperationRef,
  type ProcessRunOptions,
  type ProcessRunResult,
  type ProcessTermination,
} from "./process-supervisor.ts";

export {
  bindKernelSession,
  closeKernelSession,
  disposeSessionDomain,
  kernelDomainPath,
  kernelDomainRoot,
  notifyKernelFallback,
  resetKernelProcessForTests,
  resolveKernelSession,
  resolveProcessBackend,
  runSupervisedProcessGated,
  sweepOrphanedDomains,
  type BindKernelSessionInput,
  type OrphanedDomainRecovery,
  type ProcessBackend,
} from "./kernel-process.ts";

export {
  formatOrphanRecoveryNotice,
  formatSessionRecoveryNotice,
} from "./kernel-notice.ts";

export type {
  KernelAcceptance,
  KernelOperationFact,
  KernelRunEnd,
  KernelSession,
  KernelTurnOutcome,
} from "./kernel-session.ts";

export {
  KERNEL_PROCESS_FLAG,
  kernelProcessFlag,
  type KernelProcessFlag,
} from "./kernel-process-flag.ts";
