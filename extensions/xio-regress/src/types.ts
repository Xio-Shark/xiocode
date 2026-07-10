export type RunProvenance = Readonly<{
  schema_version: "xio-run-provenance.v1";
  workspace_root: string;
  main_root: string;
  base_commit: string;
  branch: string | null;
  dirty: boolean;
  dirty_summary_sha: string;
  xiocode_revision: string | null;
  created_at: string;
}>;

export type EvidenceReference = Readonly<{
  ref: string;
  sha256: string;
}>;

export type PromptEvidenceReference = EvidenceReference & Readonly<{
  source: "prompt_artifact" | "legacy_trajectory";
}>;

export type PrivateRegressionCase = Readonly<{
  schema_version: "private-regression-case.v1";
  case_id: string;
  created_at: string;
  source: Readonly<{
    run_id: string;
    repo_root: string;
    base_commit: string;
    dirty: boolean;
    dirty_summary_sha: string | null;
    provenance_kind: "recorded" | "user_override";
  }>;
  task: Readonly<{
    prompt_sha: string;
    failure_type: string;
    failure_statement: string;
  }>;
  verifier: Readonly<{
    command: string;
    expected_exit: number;
    timeout_ms: number;
  }>;
  runtime: Readonly<{
    provider: string | null;
    model: string | null;
    xiocode_revision: string | null;
  }>;
  evidence: Readonly<{
    prompt: PromptEvidenceReference;
    metadata: EvidenceReference;
    summary: EvidenceReference;
    trajectory: EvidenceReference;
  }>;
  privacy: Readonly<{
    classification: "local_private";
    redaction_status: "clean";
  }>;
  concerns: readonly string[];
}>;

export type PreflightStatus = "BASE_RED" | "INVALID_CASE" | "INFRA_ERROR";

export type PrivateRegressionPreflight = Readonly<{
  schema_version: "private-regression-preflight.v1";
  case_id: string;
  status: PreflightStatus;
  actual_exit: number | null;
  duration_ms: number;
  source_main_unchanged: boolean;
  artifact_hashes_match: boolean;
  temporary_worktree: string | null;
  host_isolation: "unsupported";
  concerns: readonly string[];
  errors: readonly string[];
}>;

export type RunEvidence = Readonly<{
  metadata: Readonly<{ run_id: string; provider: string | null; model: string | null }>;
  summary: Readonly<{ run_id: string; status: "success" | "failed" }>;
  prompt_sha: string;
  prompt_source: PromptEvidenceReference["source"];
  provenance: RunProvenance | null;
  references: PrivateRegressionCase["evidence"];
}>;

export type CaptureInput = Readonly<{
  run_id: string;
  failure_type: string;
  failure_statement: string;
  verifier_command: string;
  expected_exit?: number;
  timeout_ms?: number;
  repo_root?: string;
  base_commit?: string;
}>;

export type CaptureResult = Readonly<{
  status: "CAPTURED";
  case: PrivateRegressionCase;
  case_path: string;
  existing: boolean;
}>;

export type ReplayInput = Readonly<{
  schema_version: "private-regression-replay-input.v1";
  case_id: string;
  repo_root: string;
  base_commit: string;
  prompt: Readonly<{
    content: string;
    prompt_sha: string;
    source: PromptEvidenceReference["source"];
    artifact: EvidenceReference;
  }>;
  verifier: PrivateRegressionCase["verifier"];
  evidence: PrivateRegressionCase["evidence"];
}>;
