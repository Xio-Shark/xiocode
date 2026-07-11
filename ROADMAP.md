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
| ResultDenoiser + ContextInjector | ✅ | Default evolve path; `turn_start` → provider messages |
| Self-improve MVP (`xio improve`) | ✅ | T4 + verifier + MergeGate ask |
| Trusted capability baseline (`xio eval`) | ✅ | 5-family local suite; preflight/smoke/compare; stub is harness-only |
| Private regression ingestion (`xio regress`) | ✅ | Explicit verdict, evidence hashes, pinned-base red preflight |
| Private before/candidate compare (`xio regress compare`) | ✅ | Frozen verifier on before+candidate; FIXED does not authorize merge |
| Provider usage evidence | ✅ | Normalized token fields; cost remains null without a versioned price table |
| Light file outline (regex) | ✅ | Replaces web-tree-sitter |
| Provider streaming (`completeStream`) | ✅ | OpenAI + Anthropic SSE; TUI renders first delta |
| Parallel tool execution | ✅ | `parallel_tool_calls`; read/bash parallel, write/edit serial |
| Session multi-turn history | ✅ | Session retains messages; `general.max_session_messages` + explicit trim notice |
| Turn AbortSignal / TUI cancel | ✅ | Loop + fetch + bash; Ctrl+C cancels turn, idle Ctrl+C exits |
| Ink TUI core | ✅ | Alternate screen, transcript, tool rows, slash commands, model/busy/cwd status |
| Session baseline rollback (`/rollback`) | ✅ | Diff preview + confirmation; restores immutable session baseline; chat retained |
| Turn rollback (`/rollback turn`) | ✅ | Git tree checkpoint at prompt start; restores files without trimming chat |
| AGENTS.md / CLAUDE.md injection | ✅ | `xio-hygiene`; bounded `@` imports; `[agents_md]` kill-switch |
| Skills discovery (`skill` tool) | ✅ | Local `SKILL.md` roots; catalog in prompt; load on demand; `[skills]` |
| User hooks (Claude subset) | ✅ | SessionStart / PreToolUse / PostToolUse / Stop; `[hooks]` |
| MCP client (tools-first) | ✅ | `.mcp.json` + Claude/Cursor configs; stdio/SSE/HTTP; `mcp__*` |
| StrategyLearner / PromptEvolver / old strategy EvalComparator | ❌ | Removed from default path |
| SpeculativeExecutor / replay UI | ❌ | Deleted from delivery |
| pi-ace / search_context | ❌ | Not shipped (ADR 0002) |
| PathGuard / PermissionEngine / Docker | ❌ | Deleted; do not resurrect |

---

## Near term

> JD / market-admission gaps (G1–G11) and target tiers A/B/C: [docs/GOAL.md](./docs/GOAL.md#agent-harness-市场准入与-jd-对齐).
> G1–G3 are MVP-done; remaining A-tier pressure is G4–G5/G5b + G9–G10 (+ optional G11 TUI).

| Item | Priority | Notes |
|------|----------|-------|
| Real run corpus under `~/.xiocode/runs/` | P0 | Needed before stronger self-iteration claims (G10) |
| Private case → improve joint gate | P1 | Wire `compare FIXED` + trusted capability PASS before MergeGate ask (G10 remaining) |
| Credentialed capability series | P0 | Run repeated real-model smoke/compare with pinned provider/model/settings (G9) |
| Context compaction | P1 | GOAL G4; history + trim notice shipped, full compaction next |
| Persistent chat session resume | ✅ | `sessions/` store, latest/id/picker, model/messages restore, explicit delete |
| Execution checkpoint-resume | P1 | GOAL G5 remaining: recover in-progress file/tool state after interruption |
| Ink TUI diff/permission + bypass | ✅ | Merge/rollback/finalize modal, scrollable unified diff, session-only audited bypass |
| Ink TUI session resume picker | ✅ | Repository-filtered history picker plus latest/id CLI entry points |
| Tool-layer throughput (ripgrep grep/glob) | P1 | H6 follow-on after H1–H5 |
| Edit robustness (patch / fuzzy) | P1 | H8 follow-on |
| Isolation ladder docs (+ optional host path) | P1 | JD tier B; default sandbox stays worktree (G6–G7) |
| Price table + richer tracing | P1 | Cost/observability completeness (G8) |
| External eval Docker / SWE-bench wiring | P1 | Adapter stub exists; full harness later |
| TUI polish | P1 | Core, modal review, bypass, and resume shipped; remaining work is compaction/polish |
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
