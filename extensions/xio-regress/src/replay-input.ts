import { readReplayPrompt } from "./run-evidence-reader.ts";

import type { PrivateRegressionCase, ReplayInput } from "./types.ts";

export async function toReplayInput(regression: PrivateRegressionCase): Promise<ReplayInput> {
  const content = await readReplayPrompt(regression);
  const prompt = regression.evidence.prompt;
  return {
    schema_version: "private-regression-replay-input.v1",
    case_id: regression.case_id,
    repo_root: regression.source.repo_root,
    base_commit: regression.source.base_commit,
    prompt: {
      content,
      prompt_sha: regression.task.prompt_sha,
      source: prompt.source,
      artifact: { ref: prompt.ref, sha256: prompt.sha256 },
    },
    verifier: regression.verifier,
    evidence: regression.evidence,
  };
}
