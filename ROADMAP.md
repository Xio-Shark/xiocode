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
| Multi-explore subagents | 🟡 | Live `ExploreOrchestrator` + nonzero product budgets; **trellis-check passed** — archive pending — [board](./.trellis/tasks/07-15-performance-board.md) |
| Performance suite (07-15) | 🟡 | **6/8 archived**; task 7 budgets closed (awaiting archive); task 8 hard eval gate still open — [board](./.trellis/tasks/07-15-performance-board.md) · [audit](./.trellis/tasks/07-15-performance-audit-2026-07-15.md) |
| Agent Runtime Event suite | ✅ | **5/5 done** (turn_end, RuntimeEvent multi-sink, scripted tape, stream-json E2E, hard/soft steer) — [board](./.trellis/tasks/07-15-agent-runtime-event-board.md) |
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
| Session multi-turn history | ✅ | Single-owner history; `general.max_session_messages` triggers transactional compaction instead of slicing |
| Context compaction (G4) | ✅ | `/compact [focus]` + automatic trigger; same-provider summary; persisted marker; TUI lifecycle |
| Turn AbortSignal / TUI cancel | ✅ | Loop + fetch + bash; Ctrl+C cancels turn, idle Ctrl+C exits |
| Ink TUI core + polish | ✅ | Alternate screen, transcript, thinking stream/collapse, tool I/O preview, slash commands, model/busy/cwd status; select/resume accent selection; confirm scroll indicator; dynamic `/help`; busy `working…` |
| Session baseline rollback (`/rollback`) | ✅ | Diff preview + confirmation; restores immutable session baseline; chat retained |
| Turn rollback (`/rollback turn`) | ✅ | Git tree checkpoint at prompt start; restores files without trimming chat |
| AGENTS.md / CLAUDE.md injection | ✅ | `xio-hygiene`; bounded `@` imports; `[agents_md]` kill-switch |
| Skills discovery (`skill` tool) | ✅ | Local `SKILL.md` roots; catalog in prompt; load on demand; `[skills]` |
| User hooks (Claude subset) | ✅ | SessionStart / PreToolUse / PostToolUse / Stop; `[hooks]` |
| MCP client (tools-first) | ✅ | `.mcp.json` + Claude/Cursor configs; stdio/SSE/HTTP; `mcp__*`; deferred parallel connect |
| Permission modes | ✅ | `auto` / `full` / `strict`; Shift+Tab cycle; no plan/build |
| Plan board + TUI todo | ✅ | PRD/implement/tasks.json; sticky tasklist; optional CSV |
| Tool risk permissions (G7) | ✅ | Session ask / `-p` deny / `--allow-high-risk`; MCP unknown_source_fail_closed |
| `xio models` | ✅ | Catalog (+ discovery) `provider/model` lines; no worktree |
| StrategyLearner / PromptEvolver / old strategy EvalComparator | ❌ | Removed from default path |
| SpeculativeExecutor / replay UI | ❌ | Deleted from delivery |
| pi-ace / search_context | ❌ | Not shipped (ADR 0002) |
| PathGuard / PermissionEngine / Docker | ❌ | Deleted; do not resurrect |

---

## Near term

> JD / market-admission gaps (G1–G11) and target tiers A/B/C: [docs/GOAL.md](./docs/GOAL.md#agent-harness-市场准入与-jd-对齐).
> G1–G5, G5b, G9, G10, and G11 are shipped; remaining A-tier pressure is corpus quality + isolation ladder (G6/G8 polish).

| Item | Priority | Notes |
|------|----------|-------|
| Real run corpus under `~/.xiocode/runs/` | P0 | Needed before stronger self-iteration claims |
| Default private flywheel (G10) | ✅ | Failure nudge → last-case pointer → `[improve]` defaults; FIXED × PASS ask only; case ≠ goal |
| Private case → improve joint gate | ✅ | `--private-case` + `--capability-gate` require FIXED × PASS |
| Credentialed capability series | ✅ | `/connect` credentials → real smoke/compare; `--candidate-mode`/`--model`/`--repeat`; `credentialed-series.v1` (G9) |
| Context compaction | ✅ | G4 shipped at message-budget level; token-source `/context` diagnostics remain separate follow-on work |
| Persistent chat session resume | ✅ | `sessions/` store, latest/id/picker, model/messages restore, explicit delete |
| Execution checkpoint-resume | ✅ | Atomic v2 state, original worktree attach, durable turn checkpoint, no uncertain tool replay |
| Session WAL incremental journal | ✅ | Live cursor O(delta); journal P95 ~4.3ms; crash/legacy green |
| AOT / fast startup path | ✅ | early operable boot first_frame~42ms; version~25ms; parallel hygiene |
| Provider request efficiency | ✅ | Controls + schema cache + stable-prefix contract; live TTFT INFRA 503 documented |
| Workspace perception layer | ✅ | Product tools + EvidenceStore on main/explore; GitNexus merge optional |
| Adaptive explore orchestration | 🟡 | trellis-check passed; awaiting Phase-3 archive |
| Multi-axis performance/capability gate | 🟡 | Shell + safety/private rules; hard perf/awareness axes incomplete |
| Fix turn_end trajectory contract | 📋 | P0 hotfix under runtime-event suite |
| RuntimeEvent.v1 + stream-json + steer | ✅ | Delivered; WAL and Run evidence stay separate stores; follow-up: bus→TUI UI / `reportProgress()` |
| Ink TUI diff/permission + bypass | ✅ | Merge/rollback/finalize modal, scrollable unified diff, session-only audited bypass |
| Ink TUI session resume picker | ✅ | Repository-filtered history picker plus latest/id CLI entry points |
| Tool-layer throughput (host grep/glob) | ✅ | H6: ugrep→rg→grep / ugrep→rg→bfs→find; Node fallback; init recommends tools |
| Edit robustness (patch / fuzzy) | ✅ | H8: exact unique default; `replace_all`; whitespace fuzzy retry; unified `patch` |
| Isolation ladder docs (+ optional host path) | P1 | JD tier B; default sandbox stays worktree (G6); G7 risk gate shipped |
| Price table + richer tracing | P1 | Cost/observability completeness (G8) |
| External eval Docker / SWE-bench wiring | P1 | Adapter stub exists; full harness later |
| TUI polish | ✅ | Select/resume accent selection, confirm scroll indicator, busy `working…`, dynamic `/help` |
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

See [docs/STATUS.md](./docs/STATUS.md) for the single status snapshot.
