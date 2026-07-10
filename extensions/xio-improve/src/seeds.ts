import type { ImproveGoal } from "./types.ts";

/**
 * In-repo S4 seed: adapt xiocode docs/harness clarity from an external-eval-style
 * failure signal. Only touches xiocode; never merges external repo patches.
 */
export const BUILTIN_SEEDS: readonly ImproveGoal[] = [
  {
    id: "seed-s4-merge-ask-doc",
    source: "seed",
    title: "Document self-improve merge-ask (never auto-merge on green)",
    prompt:
      "Ensure XioCode self-improve docs state that a green verifier only triggers a MergeGate ask; never auto-merge into the main tree. Only change xiocode files.",
    scriptedChange: {
      path: "docs/self-improve.md",
      content: [
        "# XioCode Self-Improve Loop",
        "",
        "> Outer code-modification loop: pick a goal (T4) → edit inside a worktree → run verifier → **MergeGate ask**.",
        "",
        "## Flow",
        "",
        "1. **T4 schedule** — queue → red-test placeholders → seeds",
        "2. **WorktreeSandbox** — all edits happen in `~/.xiocode/worktrees/...`",
        "3. **Verifier** — default `npm run check` (optional extra commands)",
        "4. **MergeGate** — on green, ask the user; on red, do not merge",
        "",
        "## Merge policy (A1)",
        "",
        "- Green verifier **does not** merge into the main tree.",
        "- Merge requires explicit user consent via MergeGate (`/merge`, session-end ask, or `xio improve` prompt).",
        "- Rejecting the ask leaves the main tree unchanged.",
        "- External-eval failures may become Goals; external repo patches are never merged into xiocode.",
        "",
        "## CLI",
        "",
        "```bash",
        "xio improve              # runOnce",
        "xio improve --max 3      # runLoop",
        "./bin/xio-improve --max 1",
        "```",
        "",
        "## Out of scope",
        "",
        "- Auto-merge on green (revoked G4)",
        "- Default StrategyLearner / PromptEvolver / SpeculativeExecutor",
        "",
      ].join("\n"),
    },
    meta: {
      seedKind: "S4",
      note: "in-repo adaptation; external patches stay out",
    },
  },
];
