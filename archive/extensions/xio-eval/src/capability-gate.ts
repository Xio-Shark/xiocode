import { EvalRunner } from "./eval-runner.ts";

import type { CapabilityGate } from "../../xio-improve/src/types.ts";
import type { CandidateMode } from "./types.ts";

export function createTrustedCapabilityGate(options: Readonly<{
  trustedRoot: string;
  candidateMode?: CandidateMode;
  evalRoot?: string;
  priceTablePath?: string;
  /** Fixed trial repeats per fixture (default 1); pass-rate smoothing against single-run luck. */
  repeat?: number;
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
        repeat: options.repeat,
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
