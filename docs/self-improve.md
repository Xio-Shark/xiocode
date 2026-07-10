# XioCode Self-Improve Loop

> Outer code-modification loop: pick a goal (T4) → edit inside a worktree → run verifier → **MergeGate ask**.

## Flow

1. **T4 schedule** — queue → red-test placeholders → seeds
2. **WorktreeSandbox** — all edits happen in `~/.xiocode/worktrees/...`
3. **Verifier** — default `npm run check` (optional extra commands via `--check`)
4. **MergeGate** — on green, ask the user; on red, do not merge

## Merge policy (A1)

- Green verifier **does not** merge into the main tree.
- Merge requires explicit user consent via MergeGate (`/merge`, session-end ask, or `xio improve` prompt).
- Rejecting the ask leaves the main tree unchanged.
- External-eval failures may become Goals; external repo patches are never merged into xiocode.

## CLI

```bash
xio improve              # runOnce
xio improve --max 3      # runLoop
./bin/xio-improve --max 1
```

## Components

| Component | Role |
|-----------|------|
| `GoalStore` | queue / red_test / seeds (T4) |
| `Verifier` | default `npm run check` |
| `SelfImproveRunner` | `runOnce` / `runLoop` |
| `ExternalEvalAdapter` | stub: eval failure → Goal |
| `MergeGate` | reused from `xio-sandbox` — never bypassed |

## Out of scope

- Auto-merge on green (revoked G4 — do not resurrect)
- Default StrategyLearner / PromptEvolver / SpeculativeExecutor
- Merging external repository patches into xiocode
