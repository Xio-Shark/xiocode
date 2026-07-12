import { RegressionCaseStore, RegressionCompare } from "../../xio-regress/src/index.ts";

import type { PrivateGate, PrivateGateResult } from "./types.ts";

export type CreatePrivateRegressionGateOptions = Readonly<{
  store?: RegressionCaseStore;
  env?: NodeJS.ProcessEnv;
}>;

/** Thin adapter: private compare FIXED is evidence only until joint-gated with capability PASS. */
export function createPrivateRegressionGate(
  options: CreatePrivateRegressionGateOptions = {},
): PrivateGate {
  const env = options.env ?? process.env;
  const store = options.store ?? new RegressionCaseStore(env.XIO_REGRESSION_ROOT);
  const compare = new RegressionCompare({ store, env });
  return {
    async evaluate({ caseId, candidateRoot }): Promise<PrivateGateResult> {
      const result = await compare.evaluate({ caseId, candidateRoot });
      return {
        status: result.status,
        caseId: result.case_id,
        concerns: result.concerns,
        errors: result.errors,
      };
    },
  };
}
