import type { ImproveGoal } from "./types.ts";

/**
 * In-repo S4 seed: prompt-only. Production seeds must not overwrite docs via
 * scriptedChange; tests may still construct scripted goals explicitly.
 */
export const BUILTIN_SEEDS: readonly ImproveGoal[] = [
  {
    id: "seed-s4-merge-ask-doc",
    source: "seed",
    title: "Document self-improve merge-ask (never auto-merge on green)",
    prompt:
      "Ensure XioCode self-improve docs state that a green verifier only triggers a MergeGate ask; never auto-merge into the main tree. Only change xiocode files. Prefer a small, precise edit to docs/self-improve.md if needed.",
    meta: {
      seedKind: "S4",
      note: "prompt-only seed; scriptedChange reserved for tests/explicit determinism",
    },
  },
];
