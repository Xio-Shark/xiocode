# XioCode Self-Improve Loop

> Outer code-modification loop: pick a goal (T4) → edit inside a worktree → run verifier → **MergeGate ask**.
> Serves final-goal item 4 (self-improvable under merge-ask): [GOAL.md](./GOAL.md).

## Flow

1. **T4 schedule** — queue → red-test placeholders → seeds
2. **WorktreeSandbox** — all edits happen in `~/.xiocode/worktrees/...`
3. **Verifier** — default `npm run check` (optional extra commands via `--check`)
4. **Trusted capability gate (opt-in)** — `xio eval compare` runs from the main checkout against the candidate worktree
5. **Private joint gate (opt-in)** — `--private-case <id> --capability-gate` requires private `FIXED` **and** trusted `PASS`
6. **MergeGate** — ask only when gates pass; user approval is still required

## Merge policy (A1)

- Green verifier **does not** merge into the main tree.
- Merge requires explicit user consent via MergeGate (`/merge`, session-end ask, or `xio improve` prompt).
- Rejecting the ask leaves the main tree unchanged.
- `FAIL`, `INFRA_ERROR`, and `PASS_WITH_CONCERNS` from the opt-in capability gate do not trigger a merge ask.
- Capability green never auto-merges.
- Private `FIXED` alone never authorizes merge; with `--private-case`, trusted `PASS` alone does not either.
- External-eval failures may become Goals; external repo patches are never merged into xiocode.

## Private regression joint gate

`xio regress` cases are **not** `ImproveGoal` inputs. Capture/preflight/compare remain separate. When improving:

```bash
xio improve --private-case <id> --capability-gate
# or dogfood defaults in config.toml:
# [improve]
# capability_gate = true
# private_case = "last"   # reads ~/.xiocode/regressions/.last-case
xio improve
```

MergeGate ask may fire only when **both** hold:

1. private before/candidate `FIXED` for `<id>` against the improve worktree, and
2. trusted capability compare `PASS` (not stub / not `PASS_WITH_CONCERNS`)

`--private-case` without `--capability-gate` fails closed (same for config `private_case` without `capability_gate`). Activation UX: failed-turn hint → `/regress` or `xio regress capture --last` (still requires explicit failure statement + verifier) → durable `.last-case` pointer → improve joint gate.

**Honest boundary**: a private case is joint-gate evidence only. There is no case→GoalStore adapter on the default path.

**Prerequisite**: run evidence must be trustworthy (provider/model + numeric usage).

## CLI

```bash
xio improve              # runOnce (uses [improve] defaults when flags omitted)
xio improve --max 3      # runLoop
xio improve --capability-gate  # require trusted before/after PASS
xio improve --private-case <id|last> --capability-gate  # FIXED × PASS joint gate
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
| `xio-regress` | private case + compare; joint with capability via `--private-case` |

The trusted gate is opt-in until credentialed real-model series are established. Stub evaluation exercises controller → child → worktree → hidden grader → report, but is always reported with concerns and cannot authorize merge. Candidate package scripts and tests are advisory; they do not define the trusted outcome.

## Out of scope

- Auto-merge on green (revoked G4 — do not resurrect)
- Auto-capture from telemetry failure (user verdict still required)
- Default StrategyLearner / PromptEvolver / SpeculativeExecutor
- Merging external repository patches into xiocode
- Claiming host-level isolation: worktrees protect the main tree, but `bash` is not an OS sandbox
- Treating private base-red or `FIXED` alone as a capability PASS or automatic improve trigger
- Treating private cases as ImproveGoal inputs
- Treating MergeGate as proof of sandboxing
