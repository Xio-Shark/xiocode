import { EvalRunner } from "./eval-runner.ts";

import type { CapabilityGate } from "../../xio-improve/src/types.ts";
import type { CandidateMode } from "./types.ts";

export function createTrustedCapabilityGate(options: Readonly<{
  trustedRoot: string;
  candidateMode?: CandidateMode;
  evalRoot?: string;
  priceTablePath?: string;
  env?: NodeJS.ProcessEnv;
}>): CapabilityGate {
  return {
    async evaluate(input) {
      const runner = new EvalRunner({
        trusted_root: options.trustedRoot,
        before_root: input.mainRoot,
        candidate_root: input.candidateRoot,
        candidate_mode: options.candidateMode ?? "real",
        eval_root: options.evalRoot,
        price_table_path: options.priceTablePath,
        env: options.env,
      });
      const report = await runner.compare();
      return {
        status: report.status,
        evalId: report.eval_id,
        concerns: report.concerns,
        errors: report.errors,
      };
    },
  };
}
