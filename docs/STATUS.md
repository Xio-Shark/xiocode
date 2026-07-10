# XioCode Status

> Single delivery snapshot. Updated 2026-07-11 (trusted capability baseline + self-improve MVP; offline path green).
> Product endpoint: [GOAL.md](./GOAL.md).

## Shipping

- Self-owned TypeScript runtime (`src/runtime`)
- CLI + TOML config (`providers`, `worktree`, extension on/off)
- Builtin tools: read / write / edit / bash / grep / glob
- Outer worktree sandbox + MergeGate (`xio-sandbox`)
- Self-improve outer loop (`xio-improve` / `xio improve`) — T4 + verifier + merge-ask
- Trusted local capability baseline (`xio eval`) — versioned reports, 5 dev/holdout families, external hidden graders, preflight/smoke/compare
- User-confirmed private regression capture (`xio regress`) — versioned local cases, evidence hashes, pinned-base red preflight
- Opt-in self-improve capability gate (`xio improve --capability-gate`) — only trusted `PASS` can reach MergeGate ask
- Default evolve path: TrajectoryRecorder, RunStore, ResultDenoiser, ContextInjector, TodoEnforcer
- Provider usage normalization (input/output/cache/reasoning tokens; unknown values stay `null`)
- Secret redaction in trajectories
- Light regex file outline (no tree-sitter)

## Not on default path / not shipped

- StrategyLearner, PromptEvolver, and the old strategy-layer EvalComparator
- SpeculativeExecutor
- TrajectoryPlayer / HtmlExporter / `cli/replay`
- PrefixCacheAuditor, ActiveTools, provider-payload enhancer, parallel-tool-analyzer, context-compactor
- pi-ace-tool / `search_context` / `/ace-*`
- PathGuard / PermissionEngine / Docker (deleted; worktree model instead)
- Root `contracts/` (archived to `docs/archive/contracts/` — no code consumers)
- Auto-merge on green verifier (revoked G4; do not resurrect)
- Credentialed real-model baseline result / public benchmark claim (no local `~/.xiocode/config.toml` for this delivery; see ROADMAP)
- Host-level process isolation for eval candidates (`host_isolation` is reported as `unsupported`)
- Private before/candidate evaluator, automatic fixture minimization, or automatic run-to-improve routing

## Verify

```bash
npm run check
./test.sh
./bin/xio eval preflight --json
./bin/xio eval smoke --provider stub --json   # harness-only; not a capability claim
# xio regress create/preflight requires an existing local run and user verifier
```
