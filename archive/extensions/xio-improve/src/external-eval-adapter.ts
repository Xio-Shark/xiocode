import type { ImproveGoal } from "./types.ts";

/** Failure signal from an external benchmark (SWE-bench etc.). Stub for MVP. */
export type ExternalEvalFailure = Readonly<{
  benchmark: string;
  instanceId: string;
  failureSummary: string;
  /** Optional hint; adapter never applies external patches to xiocode. */
  externalPatchRef?: string;
}>;

/**
 * Maps external-eval failures → harness Goals.
 * Contract: only xiocode may be changed; external repo patches are never merged in.
 */
export class ExternalEvalAdapter {
  toGoal(failure: ExternalEvalFailure): ImproveGoal {
    const id = `eval-${sanitize(failure.benchmark)}-${sanitize(failure.instanceId)}`;
    const patchNote = failure.externalPatchRef
      ? ` External patch ref ${failure.externalPatchRef} must NOT be merged into xiocode.`
      : " Do not merge any external repository patch into xiocode.";

    return {
      id,
      source: "external_eval",
      title: `Harness fix for ${failure.benchmark}/${failure.instanceId}`,
      prompt: [
        `External evaluation failed on ${failure.benchmark} instance ${failure.instanceId}.`,
        `Failure: ${failure.failureSummary}`,
        "Improve only XioCode harness / agent code so similar failures are less likely.",
        patchNote.trim(),
      ].join(" "),
      meta: {
        benchmark: failure.benchmark,
        instanceId: failure.instanceId,
        ...(failure.externalPatchRef ? { externalPatchRef: failure.externalPatchRef } : {}),
      },
    };
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 64);
}
