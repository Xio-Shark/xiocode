# XioCode Status

> Single delivery snapshot. Updated 2026-07-10 (self-improve MVP + ponytail audit cleanup).

## Shipping

- Self-owned TypeScript runtime (`src/runtime`)
- CLI + TOML config (`providers`, `worktree`, extension on/off)
- Builtin tools: read / write / edit / bash / grep / glob
- Outer worktree sandbox + MergeGate (`xio-sandbox`)
- Self-improve outer loop (`xio-improve` / `xio improve`) — T4 + verifier + merge-ask
- Default evolve path: TrajectoryRecorder, RunStore, ResultDenoiser, ContextInjector, TodoEnforcer
- Secret redaction in trajectories
- Light regex file outline (no tree-sitter)

## Not on default path / not shipped

- StrategyLearner, PromptEvolver, EvalComparator
- SpeculativeExecutor
- TrajectoryPlayer / HtmlExporter / `cli/replay`
- PrefixCacheAuditor, ActiveTools, provider-payload enhancer, parallel-tool-analyzer, context-compactor
- pi-ace-tool / `search_context` / `/ace-*`
- PathGuard / PermissionEngine / Docker (deleted; worktree model instead)
- Root `contracts/` (archived to `docs/archive/contracts/` — no code consumers)
- Auto-merge on green verifier (revoked G4; do not resurrect)

## Verify

```bash
npm run check
./test.sh
```
