# XioCode Roadmap

> Honest near-term priorities after the 2026-07 ponytail audit cleanup.
> Product endpoint (what these items serve): [docs/GOAL.md](./docs/GOAL.md).

**Status key**: ✅ Done | 🟡 WIP | 📋 Planned | ❌ Out of default path

---

## Current (post-cleanup)

| Area | Status | Notes |
|------|--------|-------|
| Self-owned runtime | ✅ | `src/runtime` — no `@earendil-works/pi-*` |
| Builtin tools | ✅ | read/write/edit/bash/grep/glob |
| WorktreeSandbox + MergeGate | ✅ | Outer isolation; merge-ask |
| TrajectoryRecorder + RunStore | ✅ | Default evolve path |
| ResultDenoiser + ContextInjector | ✅ | Default evolve path |
| Self-improve MVP (`xio improve`) | ✅ | T4 + verifier + MergeGate ask |
| Trusted capability baseline (`xio eval`) | ✅ | 5-family local suite; preflight/smoke/compare; stub is harness-only |
| Private regression ingestion (`xio regress`) | ✅ | Explicit verdict, evidence hashes, pinned-base red preflight |
| Provider usage evidence | ✅ | Normalized token fields; cost remains null without a versioned price table |
| Light file outline (regex) | ✅ | Replaces web-tree-sitter |
| StrategyLearner / PromptEvolver / old strategy EvalComparator | ❌ | Removed from default path |
| SpeculativeExecutor / replay UI | ❌ | Deleted from delivery |
| pi-ace / search_context | ❌ | Not shipped (ADR 0002) |
| PathGuard / PermissionEngine / Docker | ❌ | Deleted; do not resurrect |

---

## Near term

> JD / market-admission gaps (G1–G10) and target tiers A/B/C: [docs/GOAL.md](./docs/GOAL.md#agent-harness-市场准入与-jd-对齐).

| Item | Priority | Notes |
|------|----------|-------|
| Real run corpus under `~/.xiocode/runs/` | P0 | Needed before stronger self-iteration claims (G10) |
| Private before/candidate evaluator | P0 | Pair local cases with candidate outcomes while retaining synthetic/holdout regression gates (G10) |
| Credentialed capability series | P0 | Run repeated real-model smoke/compare with pinned provider/model/settings (G9) |
| MCP client / user hooks / skills discovery | P0 | JD tier A market admission (G1–G3); see active Trellis tasks |
| Context compaction + checkpoint-resume | P1 | JD tier A deep-dive questions (G4–G5) |
| Isolation ladder docs (+ optional host path) | P1 | JD tier B; default sandbox stays worktree (G6–G7) |
| Price table + richer tracing | P1 | Cost/observability completeness (G8) |
| External eval Docker / SWE-bench wiring | P1 | Adapter stub exists; full harness later |
| REPL polish | P1 | Minimal REPL today |
| Optional Xio-native semantic search | P2 | Only if product need is real |
| Re-enable strategy loop behind explicit flag | P2 | After corpus + eval design |

---

## Docs

| Doc | Role |
|-----|------|
| [docs/GOAL.md](./docs/GOAL.md) | Final product goal |
| README.md | Product entry |
| CONTEXT.md | Glossary |
| docs/STATUS.md | Delivery status |
| docs/adr/ | Decisions |
| docs/archive/ | Historical plans, contracts, migration notes |

See [docs/STATUS.md](./docs/STATUS.md) for the single status snapshot.
