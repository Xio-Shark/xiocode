import { hashValue } from "../../xio-eval/src/suite-loader.ts";

import type { PrivateRegressionCase } from "./types.ts";

export function computeCaseId(value: Omit<PrivateRegressionCase, "case_id" | "created_at">): string {
  return hashValue({
    schema_version: value.schema_version,
    source: {
      run_id: value.source.run_id,
      repo_root: value.source.repo_root,
      base_commit: value.source.base_commit,
      dirty: value.source.dirty,
      dirty_summary_sha: value.source.dirty_summary_sha,
      provenance_kind: value.source.provenance_kind,
    },
    task: value.task,
    verifier: value.verifier,
    runtime: value.runtime,
    evidence_hashes: {
      prompt: {
        source: value.evidence.prompt.source,
        sha256: value.evidence.prompt.sha256,
      },
      metadata: value.evidence.metadata.sha256,
      summary: value.evidence.summary.sha256,
      trajectory: value.evidence.trajectory.sha256,
    },
    privacy: value.privacy,
  });
}
