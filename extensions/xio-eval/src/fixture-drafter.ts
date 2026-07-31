import type { PrivateRegressionCase } from "../../xio-regress/src/types.ts";

export type FixtureDraft = Readonly<{
  case_id: string;
  /** Template-function skeleton in fixtures.ts style (dev + holdout pair). */
  draft_ts: string;
  /** Review instructions for the human gatekeeper. */
  draft_md: string;
}>;

/**
 * Draft a trusted-fixture template from a FIXED private regression case, so the
 * exam pool grows from real failures ("reskin" the failure mode as dev+holdout).
 *
 * Deliberately a draft only: oracle/public files and grader wiring need human
 * judgment, and the case's private site details must be de-identified before
 * anything enters fixtures.ts. Output is written outside the repo and is never
 * auto-merged; the suite loader's dev+holdout pairing check is the intake gate.
 */
export function draftFixtureFromPrivateCase(regression: PrivateRegressionCase): FixtureDraft {
  const slug = familySlug(regression.task.failure_type);
  const fn = `${camelCase(slug)}Fixture`;
  const draftTs = [
    `// DRAFT — generated from private case ${regression.case_id}`,
    `// Review, de-identify, and port into extensions/xio-eval/src/fixtures.ts.`,
    `// The suite loader rejects any family missing its dev/holdout pair.`,
    ``,
    `// TODO(reviewer): pick or add a FixtureFamily for "${slug}" and a grader kind`,
    `// that observes the failure below; fill public_files (buggy), oracle_files`,
    `// (fixed, grader-side only), forbidden_paths, and two disjoint parameter sets.`,
    `function ${fn}(`,
    `  id: string,`,
    `  visibility: "dev" | "holdout",`,
    `  // TODO(reviewer): template parameters — names/inputs that differ per variant`,
    `): TrustedFixture {`,
    `  // Failure mode (from the real case; de-identify before landing):`,
    `  // ${singleLine(regression.task.failure_statement)}`,
    `  // Original verifier: ${singleLine(regression.verifier.command)} (expected exit ${regression.verifier.expected_exit})`,
    `  throw new Error("draft: not implemented");`,
    `}`,
    ``,
    `// ${fn}("${slug}-dev", "dev", /* variant A */)`,
    `// ${fn}("${slug}-holdout", "holdout", /* variant B — different names/values */)`,
    ``,
  ].join("\n");

  const draftMd = [
    `# Fixture draft from private case`,
    ``,
    `- case_id: ${regression.case_id}`,
    `- failure_type: ${regression.task.failure_type}`,
    `- failure_statement: ${singleLine(regression.task.failure_statement)}`,
    `- verifier: \`${singleLine(regression.verifier.command)}\` (expected exit ${regression.verifier.expected_exit})`,
    `- captured: ${regression.created_at}`,
    ``,
    `## Intake checklist (human gatekeeper)`,
    ``,
    `- [ ] De-identify: no project paths, prompts, or private site details survive into the fixture`,
    `- [ ] Reduce the failure mode to a small self-contained project (buggy public_files + oracle_files)`,
    `- [ ] dev and holdout variants use disjoint names/inputs (same skill, different skin)`,
    `- [ ] Grader observes the failure (f2p red on public files, green on oracle)`,
    `- [ ] \`npm run check\` green; suite preflight passes (dev/holdout pairing is enforced)`,
    ``,
    `Draft is evidence for review only — never merged automatically.`,
    ``,
  ].join("\n");

  return { case_id: regression.case_id, draft_ts: draftTs, draft_md: draftMd };
}

function familySlug(failureType: string): string {
  const slug = failureType.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "unnamed-failure";
}

function camelCase(slug: string): string {
  return slug.split("-").map((part, index) => index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
