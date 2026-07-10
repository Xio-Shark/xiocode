import { realpath } from "node:fs/promises";
import path from "node:path";

import { SecretRedactor } from "../../xio-evolve/src/secret-redactor.ts";
import { git, gitOk } from "../../xio-sandbox/src/git.ts";
import { computeCaseId } from "./case-identity.ts";
import { RegressionCaseStore } from "./case-store.ts";
import { InvalidRegressionCaseError, invalidRegressionCase } from "./errors.ts";
import { readRunEvidence } from "./run-evidence-reader.ts";

import type { CaptureInput, CaptureResult, PrivateRegressionCase, RunEvidence } from "./types.ts";

const REDACTOR = new SecretRedactor();
const DEFAULT_TIMEOUT_MS = 5_000;

export type RegressionCaptureOptions = Readonly<{
  run_root: string;
  store?: RegressionCaseStore;
  now?: () => Date;
}>;

export class RegressionCapture {
  private readonly runRoot: string;
  private readonly store: RegressionCaseStore;
  private readonly now: () => Date;

  constructor(options: RegressionCaptureOptions) {
    this.runRoot = path.resolve(options.run_root);
    this.store = options.store ?? new RegressionCaseStore();
    this.now = options.now ?? (() => new Date());
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    validateVerdict(input);
    const evidence = await readRunEvidence(this.runRoot, input.run_id)
      .catch((error: unknown) => { throw invalidRegressionCase(error); });
    const source = await resolveSource(evidence, input)
      .catch((error: unknown) => { throw invalidRegressionCase(error); });
    const concerns = captureConcerns(evidence, source.provenance_kind);
    const partial = caseWithoutIdentity({ input, evidence, source, concerns });
    assertSecretFree(partial);
    const regression: PrivateRegressionCase = {
      ...partial,
      case_id: computeCaseId(partial),
      created_at: this.now().toISOString(),
    };
    const written = await this.store.writeCase(regression);
    return { status: "CAPTURED", case: regression, ...written };
  }
}

async function resolveSource(
  evidence: RunEvidence,
  input: CaptureInput,
): Promise<PrivateRegressionCase["source"]> {
  const recorded = evidence.provenance;
  if (!recorded && (!input.repo_root || !input.base_commit)) {
    throw new InvalidRegressionCaseError("legacy run requires explicit --repo and --base");
  }
  const requestedRepo = input.repo_root ? path.resolve(input.repo_root) : recorded!.main_root;
  const repoRoot = await realpath(path.resolve(await gitOk(requestedRepo, ["rev-parse", "--show-toplevel"])));
  if (recorded && await realpath(recorded.main_root) !== repoRoot) {
    throw new InvalidRegressionCaseError("recorded provenance does not match --repo");
  }
  const baseCommit = await resolveCommit(repoRoot, input.base_commit ?? recorded!.base_commit);
  if (recorded) {
    const recordedCommit = await resolveCommit(repoRoot, recorded.base_commit);
    if (baseCommit !== recordedCommit) {
      throw new InvalidRegressionCaseError("recorded provenance does not match --base");
    }
  }
  return {
    run_id: input.run_id,
    repo_root: repoRoot,
    base_commit: baseCommit,
    dirty: recorded?.dirty ?? true,
    dirty_summary_sha: recorded?.dirty_summary_sha ?? null,
    provenance_kind: recorded ? "recorded" : "user_override",
  };
}

async function resolveCommit(repoRoot: string, revision: string): Promise<string> {
  const result = await git(repoRoot, ["rev-parse", "--verify", `${revision}^{commit}`]);
  if (result.code !== 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(result.stdout)) {
    throw new InvalidRegressionCaseError(`base commit is unavailable: ${revision}`);
  }
  return result.stdout;
}

function caseWithoutIdentity(options: Readonly<{
  input: CaptureInput;
  evidence: RunEvidence;
  source: PrivateRegressionCase["source"];
  concerns: readonly string[];
}>): Omit<PrivateRegressionCase, "case_id" | "created_at"> {
  const { input, evidence, source, concerns } = options;
  return {
    schema_version: "private-regression-case.v1",
    source,
    task: {
      prompt_sha: evidence.prompt_sha,
      failure_type: input.failure_type.trim(),
      failure_statement: input.failure_statement.trim(),
    },
    verifier: {
      command: input.verifier_command.trim(),
      expected_exit: input.expected_exit ?? 0,
      timeout_ms: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    },
    runtime: {
      provider: evidence.metadata.provider,
      model: evidence.metadata.model,
      xiocode_revision: evidence.provenance?.xiocode_revision ?? null,
    },
    evidence: evidence.references,
    privacy: { classification: "local_private", redaction_status: "clean" },
    concerns,
  };
}

function captureConcerns(evidence: RunEvidence, provenanceKind: "recorded" | "user_override"): readonly string[] {
  const concerns: string[] = [];
  if (provenanceKind === "user_override") concerns.push("legacy_provenance_override");
  if (evidence.prompt_source === "legacy_trajectory") concerns.push("legacy_prompt_from_trajectory");
  if (evidence.provenance?.dirty) concerns.push("source_workspace_was_dirty");
  if (!evidence.metadata.provider) concerns.push("provider_identity_unavailable");
  if (!evidence.metadata.model) concerns.push("model_identity_unavailable");
  if (!evidence.provenance?.xiocode_revision) concerns.push("xiocode_revision_unavailable");
  return concerns.sort();
}

function validateVerdict(input: CaptureInput): void {
  if (!input.failure_type.trim()) throw new InvalidRegressionCaseError("--failure-type is required");
  if (!input.failure_statement.trim()) throw new InvalidRegressionCaseError("--failure is required");
  if (!input.verifier_command.trim()) throw new InvalidRegressionCaseError("--verify is required");
  const expected = input.expected_exit ?? 0;
  const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(expected) || expected < 0 || expected > 255) {
    throw new InvalidRegressionCaseError("--expect-exit must be an integer from 0 to 255");
  }
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 600_000) {
    throw new InvalidRegressionCaseError("--timeout-ms must be an integer from 1 to 600000");
  }
}

function assertSecretFree(value: unknown): void {
  if (JSON.stringify(REDACTOR.redact(value)) !== JSON.stringify(value)) {
    throw new InvalidRegressionCaseError("case fields contain a recognized secret pattern");
  }
}
