# XioCode Domain Glossary

> Resolved domain terms. No implementation dump.

---

## Product

- **XioCode**: local-first AI coding agent with a self-owned TypeScript runtime (`src/runtime`), outer worktree isolation, and run evidence under `~/.xiocode/runs/`.
- **Positioning (2026-07-16)**: single-operator daily driver + agent-engineering testbed first; open-sourcing for a wider audience is deferred until a self-set milestone. Differentiation claims are judged against "unique for the operator's workflow", not against the market feature matrix.
- **Identity (2026-09-06)**: the flagship capability is the trustable-autonomy chain — worktree isolation + MergeGate + turn-level rollback + run evidence. The failure-driven self-calibration loop (capture → case library → eval gate) was retired and its implementation removed on 2026-09-06; do not describe it as an active capability. Orchestration breadth and TUI breadth are explicitly not the identity.
- **TUI scope (2026-07-16)**: feature surface frozen (markdown render, `@` file mention, usage status, `/model` are in). Remaining TUI work is aesthetics / motion / smoothness polish only — no new interaction features; themes, custom keybindings, images stay out.
- **Goal / north star**: observable, rollback-safe local coding-agent loop under user MergeGate consent — see [docs/GOAL.md](./docs/GOAL.md).
- **`xio`**: CLI binary. Reads `~/.xiocode/config.toml`, starts the TTY Ink session (or non-TTY/one-shot path), loads extensions in-process.
- **Harness**: layer between the LLM and the execution environment (tool calls ↔ file/shell actions).
- **Orchestration (调度机)**: the request→result pipeline — context assembly, model routing, tool dispatch, subagent fan-out (explore waves), result aggregation. Optimization target is **task outcome quality and round-trip count**, explicitly not token cost. Cross-session/background task scheduling is out of scope (2026-07-16).
- **Round-trip budget**: the dominant cost of a session is provider round trips, not local tool execution. Anything that adds a model turn (forced fan-out, ordered re-runs, redundant verification) is judged against that budget.

## Architecture

- **Base strategy**: self-owned runtime under `src/runtime`. Historical pi-agent dependency removed ([ADR 0002](./docs/adr/0002-remove-pi-agent.md)).
- **Extension**: unit registered via `XioExtensionAPI` (`registerTool` / `registerCommand` / `on`). Lives under `extensions/`.
- **Language**: TypeScript (erasable-only).

## Extensions

- **xio-sandbox**: opt-in outer git worktree sandbox (`[worktree] enabled = true`). Default direct-cwd: agent runs in the launch directory (git optional). When enabled, `prepareLaunch` creates `~/.xiocode/worktrees/<repo_id>/<session_id>`; `/merge` and session-end use MergeGate. Also ships `DirectRollbackGate` (snapshot-based `/rollback` in direct-cwd mode).
- **xio-evolve** (default path): TodoEnforcer addendum, TrajectoryRecorder, RunStore, ResultDenoiser, ContextInjector, error tracker, file outline, provenance, secret redactor, runtime status, retrospective. StrategyLearner / PromptEvolver / EvalComparator / SpeculativeExecutor are **removed** — do not reintroduce them on the default path.
- **xio-hygiene**: in-place agent hygiene — AGENTS.md / CLAUDE.md injection, local skills discovery (`skill` tool), Claude-settings user hooks (SessionStart / PreToolUse / PostToolUse / Stop), tools-first MCP client (`mcp__*`). Kill-switches under `config.toml` `[agents_md]` / `[skills]` / `[hooks]` / `[mcp]`.
- **xio-setup**: first-run setup (`xio-setup`, provider setup, Trellis scaffolding, templates).

## Run evidence

- **Run**: one session, id `run_YYYYMMDD_HHMMSS`, stored at `~/.xiocode/runs/<run_id>/`.
- **Chat session**: resumable model/message history stored at `~/.xiocode/sessions/<session_id>/`; separate from run evidence; resumed into direct cwd or reattached worktree per saved `workspace.mode`.
- **Trajectory**: prompts, tool calls/results, todos, timing — `events.jsonl` + `trajectory.json`.
- **Perf spans**: `~/.xiocode/perf/<bench_id>/` — span trace (process_start, first_frame, prompt_ready, provider.request, provider.first_token, provider.completion, tool.batch, checkpoint.persist, tui.paint, subagent.*) plus a report. Use it to judge latency changes instead of wall-clock feel.

## Active infra (default path)

- **ResultDenoising** (ResultDenoiser): truncate long tool outputs; light regex outline for large source files; stack-trace truncation.
- **Dynamic Context Injection** (ContextInjector): inject git branch/status/recent commits for non-simple prompts; `turn_start` return value merged into provider messages. Immunity rules ride the same dynamic tail, which keeps them off the prompt-cache breakpoint.
- **Provider streaming**: `completeStream` (OpenAI / Anthropic SSE); the Ink transcript renders deltas through `SessionUiSink`.
- **Parallel tool scheduling**: read/bash may run in parallel; write/edit stay serial. Independent probes are expected to be batched into one round.
- **Session multi-turn**: runtime retains messages; `general.max_session_messages` + explicit trim notice (not full compaction).
- **Repeat tool fuse**: identical tool+args is blocked after `general.repeat_tool_limit` (default 3) consecutive calls. Keys on exact arguments only — it does not catch semantically-equivalent re-probing, by design (measured rate is too low and mostly legitimate).
- **Multi-explore**: opt-in `[explore]` — primary session model keeps the loop; `explore` tool spawns parallel read-only subagents on a separate model (e.g. Pro primary + Flash workers). Default hard cap **4** concurrent (`max_concurrency` 1–16); runtime **suggests** fan-out from workspace scale. Workers: read/grep/glob only (optional bash); no nested explore. Explore is never mandatory.

## Safety & sandbox

- **WorktreeSandbox**: opt-in session-outer isolation; non-git dirs are allowed in default direct-cwd mode; worktree mode requires git.
- **MergeGate**: diff summary + confirm before merging worktree branch into main tree; conflicts abort and keep worktree. Never "测绿即合".
- **Permission modes**: `auto` (default) / `full` / `strict` — Shift+Tab or `/permission`; no plan/build split. Strict = read/search tools only; auto asks on high-risk; full auto-allows high-risk.
- **User hooks**: PreToolUse can block tools (exit 2 / JSON deny); not a resurrected PathGuard / PermissionEngine.
- **Workspace containment**: builtin `write`/`edit` use `assertInsideWorkspace` against agent cwd. PathGuard / PermissionEngine / Docker were removed; do not reintroduce.
- **Config**: `[worktree] enabled` (default false), `retain_on_reject`.

## Intelligence & diagnostics

- **Project Immunity Engine**: `/rollback` and `! hard steer` are distilled into project-scoped `ImmunityRule`s (pattern-extracted file list + templated lesson), stored under `~/.xiocode` and injected into later turns via ContextInjector. Mechanical, not model-generated.
- **Blast Radius Probe** (`src/runtime/tools/blast-radius.ts`): per-language regex extraction of changed exported symbols, then a workspace search for references. Not AST-based. Runs on edit behind a try/catch; failures are non-blocking.
- **Speculative Worktree Racing** (`extensions/xio-sandbox/src/racing.ts`): `runSpeculativeRace` / `applyRaceWinner` — candidates run concurrently in isolated worktrees and are arbitrated by `min_diff` / `fastest` / `highest_score`. **Experimental and not reachable from the default agent loop**; `/race` prints status only.
- **Rollback**: `/rollback turn` (latest turn) and `/rollback` (session baseline) via snapshot gates; preserves unrelated uncommitted local diffs.

## Tools

- Builtin: `read`, `write`, `edit`, `bash`, `grep`, `glob`, `plan`.
- Optional: `explore` when `[explore] enabled` (read-only multi-subagent research).
- **Plan board**: `plan` tool writes `.claude/plan/{prd.md,implement.md,tasks.json}` (+ optional `tasks.csv`; legacy `.xiocode/plan` readable); TUI sticky **tasklist** widget; `/plan` refreshes.
- **Agent config**: Claude Code layout (`.claude/`, `~/.claude/`, root `CLAUDE.md`/`AGENTS.md`). `~/.xiocode` holds runtime state only (not skills/rules).
- Hygiene: `skill` (list/load local `SKILL.md`); MCP tools as `mcp__<server>__<tool>`.
- **Error guidance**: tool failures append a `Fix:` line (`src/runtime/tools/error-guidance.ts`). Bash hints must not order an unconditional re-run — probe/pipeline commands exit non-zero while already returning the evidence.
- **Commands**: `/connect`, `/model`, `/rollback [turn]`, `/immunity [clear]`, `/race`, `/compact`, `/clear`, `/help`. `/regress` is a deprecated stub that points at `/immunity`.

## Decision history (short)

- **Self-calibration flywheel (eval / regress / improve)** — retired 2026-09-06; implementation removed. Re-entry requires a real user signal.
- **Tag protocol** — rejected (multi-param tools + narrative ambiguity).
- **Reasonix fork** — rejected (MCP cannot observe agent loop).
- **pi-agent base** — superseded by ADR 0002 (own the runtime).
- **Docker / PathGuard / PermissionEngine** — removed in favor of outer worktree + MergeGate.
- **Semantic repeat guard** — rejected: measured 15 re-runs after failure in 1101 bash calls, and the majority were legitimate retries (installs, container starts, helm timeouts).
