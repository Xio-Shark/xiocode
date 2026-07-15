# XioCode Status

> Single delivery snapshot. Updated 2026-07-12 (product-completeness children G5–G10, H6, H8, TUI polish shipped).
> Product endpoint: [GOAL.md](./GOAL.md). Near-term: [ROADMAP.md](../ROADMAP.md).
## Shipping

- Self-owned TypeScript runtime (`src/runtime`)
- CLI + TOML config (`providers`, `worktree`, extension on/off)
- Builtin tools: read / write / edit / bash / grep / glob
- Outer worktree sandbox + MergeGate (`xio-sandbox`) — **protects main-tree merge only; not OS isolation**
- Self-improve outer loop (`xio-improve` / `xio improve`) — T4 + verifier + merge-ask
- **Post-task retrospective**: each full agent task → blocker log + washed report under run dir; inject next turn for primary agent; high/medium actions enqueue entropy-keyed ImproveGoal drafts (`~/.xiocode/improve/queue/entropy-*.json`, MergeGate only; `/retrospect`)
- **Tool/contract Fix hints**: builtin write/edit/bash/grep/glob errors and done-contract failures append `Fix:` next-step guidance (self-correct without longer system prompts)
- **Architecture guards**: vitest locks extensions/runtime ↛ `src/tui` and default evolve/extension assembly not wiring StrategyLearner / PromptEvolver / SpeculativeExecutor
- Trusted local capability baseline (`xio eval`) — versioned reports, 5 dev/holdout families, external hidden graders, preflight/smoke/compare
- User-confirmed private regression capture (`xio regress`) — versioned local cases, evidence hashes, pinned-base red preflight
- Private before/candidate compare (`xio regress compare`) — `FIXED` / `STILL_RED` / …; **does not authorize MergeGate**
- Opt-in self-improve capability gate (`xio improve --capability-gate`) — only trusted `PASS` can reach MergeGate ask
- Opt-in joint gate (`--private-case` + `--capability-gate`) — private `FIXED` × trusted `PASS` required together
- **Default private flywheel (G10)**: failed turns nudge `/regress` / `xio regress capture --last` (with run id when known); successful capture writes `~/.xiocode/regressions/.last-case`; `[improve] capability_gate` / `private_case` supply dogfood defaults for bare `xio improve` (CLI flags still override); joint FIXED × PASS still asks only — never auto-merges; **private case ≠ ImproveGoal**
- **Credentialed capability evidence (G9)**: real eval loads `/connect` credentials; `--candidate-mode` / `--model provider/model` / `--repeat N`; selected-provider child env allowlist only; `credentialed-series.v1` under eval root; stub remains harness-only `PASS_WITH_CONCERNS`
- Default evolve path: TrajectoryRecorder, RunStore, ResultDenoiser, ContextInjector, TodoEnforcer
- **Run evidence integrity**: `session_start` writes provider/model into `metadata.json`; `model_change` updates them; SecretRedactor does not wipe `*Tokens` usage counters in events
- **Dirty main policy**: with worktree enabled, dirty main trees hard-fail unless `xio --allow-dirty` or `[worktree] allow_dirty = true` (avoids clean-HEAD sessions silently ignoring uncommitted files)
- **Tool risk permissions**: risk classes `read|search|write|exec|network|merge`; plan mode denies write/exec/MCP; build interactive asks once per high-risk tool; `-p` denies unless `--allow-high-risk` / `[permissions] allow_high_risk`; `/bypass` still auto-approves with audit notify; `[mcp] unknown_source_fail_closed` skips Claude/Cursor auto-import; `host_isolation: unsupported` in `/status`
- **Regress activation MVP**: `/regress` (session) + `xio regress capture --last` (defaults `failure_type`); auto-preflight; `create --help` is valid help (not INVALID_CASE)
- **Improve joint gate**: `xio improve --private-case <id> --capability-gate` requires private `FIXED` × trusted `PASS` before MergeGate ask; either alone never asks
- **AGENTS.md / CLAUDE.md injection**, **Skills**, **User hooks**, **MCP client** (`xio-hygiene`) — MVP boundaries unchanged (not full Claude clones)
- **Permission modes** (`strict` / `auto` / `full`; Shift+Tab or `/permission`), **`xio models`**, Ink TUI core + merge/rollback/bypass + session resume
- **Plan board**: `plan` tool → PRD + implement + `tasks.json` under **`.claude/plan/`** (Claude Code tree; legacy `.xiocode/plan` still readable); TUI todo panel; `plan update`
- **Agent config layout**: Claude Code paths only — `CLAUDE.md` / `.claude/CLAUDE.md` / skills / hooks / MCP; `~/.xiocode` is runtime state (config, runs, sessions, worktrees, evals, regress, improve), not a second skills tree
- **Ink TUI polish**: select/resume accent selection (slash contract); confirm scroll `lines a–b/n`; busy header `working…`; `/help` from `collectSlashCommands`
- **Context compaction G4**: one session-history owner; `/compact [focus]`; automatic `max_session_messages` trigger; same-provider continuation summary; complete-turn/tool-pair retention; atomic snapshot publish; persisted resume marker; stdout/Ink start/success/failure visibility
- **Execution/file checkpoint-resume G5**: atomic `xio-session.v2` state; v1 load compatibility; original worktree attach/validation; durable hidden-ref turn checkpoint; provider/tool progress snapshots; interrupted tool calls closed as `completion unknown` without replay; resumed MergeGate rollback checkpoint; Ink recovery notice
- Provider usage normalization (input/output/cache/reasoning; unknown → `null`)
- Secret redaction in trajectories (env-style `*TOKEN` / secrets still redacted; usage counters preserved)
- Harness throughput H1–H5; session/turn rollback G5b
- **Host search backends**: builtin `grep` order `ugrep → rg → grep → node`; `glob` order `ugrep → rg → bfs → find → node` (caps 100/500); first `xio init` / config create recommends optional `ugrep`/`ripgrep`/`bfs` without requiring install
- **Robust edit (H8)**: builtin `edit` keeps exact unique replace; optional `replace_all`; one whitespace fuzzy retry (CRLF→LF, trim trailing WS) annotated `fuzzy: whitespace normalized`; optional unified `patch` via `diff` applyPatch; workspace + verifyWriteBack unchanged
- **Multi-explore (Pro→Flash style)**: opt-in `[explore]` registers `explore` tool; primary agent can fan out parallel read-only subagents on `explore.model` (timeout, concurrency, no recursion); plan mode allows explore

## Known gaps (honest — do not paper over)

- **Identity–behavior gap**: north star wiring is present (evidence → dirty-main → risk → capture → joint gate → config defaults); daily dogfood still requires the operator to confirm failure + verifier and approve MergeGate.

## Not on default path / not shipped

- StrategyLearner, PromptEvolver, old strategy EvalComparator, SpeculativeExecutor, replay UI
- Token-accurate context-source breakdown (`/context`)
- PathGuard / PermissionEngine / Docker (deleted; worktree model instead)
- Auto-merge on green verifier (revoked; do not resurrect)
- Auto-capture from `run.status=failed` (still requires explicit failure statement + verifier)
- Credentialed public capability claims beyond what a checked-in series artifact proves
- Host-level isolation (`host_isolation: unsupported`)
- Private case → GoalStore / ImproveGoal adapter (cases remain joint-gate evidence only)
- Cross-repo replay
- Full Claude hooks / MCP resources·prompts·OAuth marketplace

## Verify

```bash
npm run check
./test.sh
./bin/xio eval preflight --json
./bin/xio eval smoke --candidate-mode stub --json   # harness-only; not a capability claim
# Credentialed (manual): ./bin/xio eval smoke --candidate-mode real --model <provider>/<model> --case local-bug-holdout --repeat 1 --json
# Evidence: ./bin/xio -p "ok" && jq . ~/.xiocode/runs/<latest>/metadata.json
# xio regress create/preflight requires an existing local run and user verifier
```

### G9 credentialed smoke (manual, 2026-07-12)

- Command: `xio eval smoke --candidate-mode real --model opencode-go/deepseek-v4-flash --case local-bug-holdout --repeat 1 --json`
- Status: `PASS_WITH_CONCERNS` (smoke baseline + pricing unavailable; not a public capability claim)
- `eval_id`: `eval-2026-07-12T12-36-43-563Z-a63ebb4b`
- `series_id`: `f29697b997912c1dcbe97db82b41dddca39241c15528b175f9778820eb926700`
- Usage (nullable cost): input `20051`, output `1515`, cache `19200`, reasoning `703`, `estimated_cost_usd` `null`
- Series path: `~/.xiocode/evals/series/<series_id>/credentialed-series.json` (no keys in artifact)
