# XioCode Self-Improve Loop

> Outer code-modification loop: pick a goal (T4) → edit inside a worktree → run verifier → **MergeGate ask**.
> Serves final-goal item 4 (self-improvable under merge-ask): [GOAL.md](./GOAL.md).

## Flow

1. **T4 schedule** — queue → red-test placeholders → seeds
2. **WorktreeSandbox** — all edits happen in `~/.xiocode/worktrees/...`
3. **Verifier** — default `npm run check` (optional extra commands via `--check`)
4. **Trusted capability gate (opt-in)** — `xio eval compare` runs from the main checkout against the candidate worktree
5. **MergeGate** — only verifier green plus trusted `PASS` may ask; user approval is still required

## Merge policy (A1)

- Green verifier **does not** merge into the main tree.
- Merge requires explicit user consent via MergeGate (`/merge`, session-end ask, or `xio improve` prompt).
- Rejecting the ask leaves the main tree unchanged.
- `FAIL`, `INFRA_ERROR`, and `PASS_WITH_CONCERNS` from the opt-in capability gate do not trigger a merge ask.
- Capability green never auto-merges.
- External-eval failures may become Goals; external repo patches are never merged into xiocode.

## CLI

```bash
xio improve              # runOnce
xio improve --max 3      # runLoop
xio improve --capability-gate  # require trusted before/after PASS
./bin/xio-improve --max 1
```

## Components

| Component | Role |
|-----------|------|
| `GoalStore` | queue / red_test / seeds (T4) |
| `Verifier` | default `npm run check` |
| `SelfImproveRunner` | `runOnce` / `runLoop` |
| `ExternalEvalAdapter` | stub: eval failure → Goal |
| `xio-eval` | trusted local fixtures, external hidden grader, versioned before/after report |
| `MergeGate` | reused from `xio-sandbox` — never bypassed |

The trusted gate is opt-in until credentialed real-model series are established. Stub evaluation exercises controller → child → worktree → hidden grader → report, but is always reported with concerns and cannot authorize merge. Candidate package scripts and tests are advisory; they do not define the trusted outcome.

`xio regress` cases are not `ImproveGoal` inputs in this delivery. A private
case can prove that its pinned base is red (`preflight`) and whether a
candidate checkout fixes the frozen verifier (`compare` → `FIXED` /
`STILL_RED`). Neither result enables MergeGate by itself.
Future integration must require both private before/candidate improvement and
no stable regression in the trusted synthetic/holdout suite.

## Out of scope

- Auto-merge on green (revoked G4 — do not resurrect)
- Default StrategyLearner / PromptEvolver / SpeculativeExecutor
- Merging external repository patches into xiocode
- Claiming host-level isolation: worktrees protect the main tree, but `bash` is not an OS sandbox
- Treating private base-red evidence as a capability PASS or automatic improve trigger
- Session code rollback / Ink TUI (product UX; tracked under GOAL G5b / G11 and ROADMAP — not part of `xio improve`)
