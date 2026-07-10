# XioCode Roadmap

> Honest near-term priorities after the 2026-07 ponytail audit cleanup.

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
| Light file outline (regex) | ✅ | Replaces web-tree-sitter |
| StrategyLearner / PromptEvolver / EvalComparator | ❌ | Removed from default path |
| SpeculativeExecutor / replay UI | ❌ | Deleted from delivery |
| pi-ace / search_context | ❌ | Not shipped (ADR 0002) |
| PathGuard / PermissionEngine / Docker | ❌ | Deleted; do not resurrect |

---

## Near term

| Item | Priority | Notes |
|------|----------|-------|
| Real run corpus under `~/.xiocode/runs/` | P0 | Needed before stronger self-iteration claims |
| External eval Docker / SWE-bench wiring | P1 | Adapter stub exists; full harness later |
| REPL polish | P1 | Minimal REPL today |
| Optional Xio-native semantic search | P2 | Only if product need is real |
| Re-enable strategy loop behind explicit flag | P2 | After corpus + eval design |

---

## Docs

| Doc | Role |
|-----|------|
| README.md | Product entry |
| CONTEXT.md | Glossary |
| docs/STATUS.md | Delivery status |
| docs/adr/ | Decisions |
| docs/archive/ | Historical plans, contracts, migration notes |

See [docs/STATUS.md](./docs/STATUS.md) for the single status snapshot.
