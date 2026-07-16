# XioCode Domain Glossary

> Resolved domain terms. No implementation dump.

---

## Product

- **XioCode**: local-first AI coding agent with a self-owned TypeScript runtime (`src/runtime`), outer worktree isolation, and run evidence under `~/.xiocode/runs/`.
- **Positioning (2026-07-16)**: single-operator daily driver + agent-engineering testbed first; open-sourcing for a wider audience is deferred until a self-set milestone. Differentiation claims are judged against "unique for the operator's workflow", not against the market feature matrix.
- **Open-source milestone (2026-07-16)**: first full flywheel cycle under real daily use — a genuine failure, captured as a case, fixed by an orchestration change that passes the eval gate on a 10+ case library and merges through MergeGate, while xiocode is the operator's actual daily driver. Both conditions must hold; either alone does not trigger the decision.
- **Identity (2026-07-16)**: the two flagship capabilities are (1) the trustable-autonomy chain (worktree + MergeGate + rollback + run evidence) and (2) the failure-driven orchestration self-calibration loop (capture → case library → eval-gated experiment). Orchestration breadth and TUI breadth are explicitly not the identity.
- **TUI scope (2026-07-16)**: feature surface frozen (markdown render, `@` file mention, usage status, `/model` are in). Remaining TUI work is aesthetics / motion / smoothness polish only — no new interaction features; themes, custom keybindings, images stay out.
- **Goal / north star**: observable, rollback-safe, self-improvable local coding-agent loop under user MergeGate consent — see [docs/GOAL.md](./docs/GOAL.md).
- **`xio`**: CLI binary. Reads `~/.xiocode/config.toml`, starts the TTY Ink session (or non-TTY/one-shot path), loads extensions in-process.
- **Harness**: layer between the LLM and the execution environment (tool calls ↔ file/shell actions).
- **Orchestration (调度机)**: the request→result pipeline — context assembly, model routing, tool dispatch, subagent fan-out (explore waves), result aggregation. Optimization target is **task outcome quality**, explicitly not token cost. Cross-session/background task scheduling is out of scope (2026-07-16).
- **Orchestration quality oracle (2026-07-16)**: orchestration changes are judged by (1) private regression cases (`xio regress`) captured from the operator's real failures — primary judge; (2) `xio eval compare` as the gate. Subjective feel and external public benchmarks are rejected as judges.
- **Orchestration variant (2026-07-16)**: a variant is a git ref (code + config as a whole), compared via the existing eval path. Tunables get promoted from code into `config.toml` on demand, one experiment at a time — no upfront policy DSL. Machine-proposed variants (StrategyLearner / PromptEvolver) stay off the default path until the regression case library has meaningful size.

## Architecture

- **Base strategy**: self-owned runtime under `src/runtime`. Historical pi-agent dependency removed ([ADR 0002](./docs/adr/0002-remove-pi-agent.md)).
- **Extension**: unit registered via `XioExtensionAPI` (`registerTool` / `registerCommand` / `on`). Lives under `extensions/`.
- **Language**: TypeScript (erasable-only).

## Extensions

- **xio-sandbox**: opt-in outer git worktree sandbox (`[worktree] enabled = true`). Default direct-cwd: agent runs in the launch directory (git optional). When enabled, `prepareLaunch` creates `~/.xiocode/worktrees/<repo_id>/<session_id>`; `/merge` and session-end use MergeGate.
- **xio-evolve** (default path): TodoEnforcer addendum, TrajectoryRecorder, RunStore, ResultDenoiser, ContextInjector. StrategyLearner / PromptEvolver / EvalComparator are **not** on the default path.
- **xio-hygiene**: in-place agent hygiene — AGENTS.md / CLAUDE.md injection, local skills discovery (`skill` tool), Claude-settings user hooks (SessionStart / PreToolUse / PostToolUse / Stop), tools-first MCP client (`mcp__*`). Kill-switches under `config.toml` `[agents_md]` / `[skills]` / `[hooks]` / `[mcp]`.
- **xio-improve**: self-modification outer loop (`xio improve` / `bin/xio-improve`). T4 GoalStore → worktree edits → verifier → **MergeGate ask**. Green verifier never auto-merges.
- **xio-eval**: trusted local evaluator. Materializes tiny public fixtures, starts the candidate in its normal worktree path, then runs hidden graders from outside the candidate workspace and writes a versioned report.
- **xio-regress**: private regression capture (`xio regress`). User verdict + frozen verifier + evidence hashes; pinned-base red preflight. Does not authorize merge.
- **Case capture flow (2026-07-16)**: failure signals (turn failed / hard steer / `/rollback`) offer one-key capture when `[regress] offer_on_failure = true` → explore-style subagent drafts `failure_statement` (artifact seed/fallback) → operator confirms; enrichment never blocks capture; silent auto-capture rejected. Gate: no orchestration-code experiments before the library holds 10 cases.

## Run evidence

- **Run**: one session, id `run_YYYYMMDD_HHMMSS`, stored at `~/.xiocode/runs/<run_id>/`.
- **Chat session**: resumable model/message history stored at `~/.xiocode/sessions/<session_id>/`; separate from run/eval evidence; resumed into direct cwd or reattached worktree per saved `workspace.mode`.
- **Trajectory**: prompts, tool calls/results, todos, timing — `events.jsonl` + `trajectory.json`.
- **Eval report**: before/after quality, safety, latency, efficiency, nullable usage, hashes, and run references under `~/.xiocode/evals/<eval_id>/`; not a second trajectory store.
- **Private case**: `~/.xiocode/regressions/<case_id>/case.json` — references run artifacts; does not copy prompt text or trajectories.

## Active infra (default path)

- **ResultDenoising** (ResultDenoiser): truncate long tool outputs; light regex outline for large source files; stack-trace truncation.
- **Dynamic Context Injection** (ContextInjector): inject git branch/status/recent commits for non-simple prompts; `turn_start` return value merged into provider messages.
- **Provider streaming**: `completeStream` (OpenAI / Anthropic SSE); the Ink transcript renders deltas through `SessionUiSink`.
- **Parallel tool scheduling**: read/bash may run in parallel; write/edit stay serial.
- **Session multi-turn**: runtime retains messages; `general.max_session_messages` + explicit trim notice (not full compaction).
- **Prompt classification**: tiny binary simple vs code classifier (optional model hint from config). Not a full multi-model router product.
- **Multi-explore**: opt-in `[explore]` — primary session model keeps the loop; `explore` tool spawns parallel read-only subagents on a separate model (e.g. Pro primary + Flash workers). Default hard cap **4** concurrent (`max_concurrency` 1–16); runtime **suggests** fan-out from workspace scale (tiny→1 … huge→up to cap). Each worker owns a **small** slice (partition by API/feature/package/… or `partition_hint` / user). Workers: read/grep/glob only (optional bash); no nested explore.

## Safety & sandbox

- **WorktreeSandbox**: opt-in session-outer isolation; non-git dirs are allowed in default direct-cwd mode; worktree mode requires git.
- **MergeGate**: diff summary + confirm before merging worktree branch into main tree; conflicts abort and keep worktree. Self-improve reuses the same gate — never “测绿即合”.
- **Permission modes**: `auto` (default) / `full` / `strict` — Shift+Tab or `/permission`; no plan/build split. Strict = read/search tools only; auto asks on high-risk; full auto-allows high-risk.
- **User hooks**: PreToolUse can block tools (exit 2 / JSON deny); not a resurrected PathGuard / PermissionEngine.
- **Workspace containment**: builtin `write`/`edit` use `assertInsideWorkspace` against agent cwd. PathGuard / PermissionEngine / Docker were removed; do not reintroduce.
- **Config**: `[worktree] enabled` (default false), `retain_on_reject`.

## Self-improve

- **T4**: GoalStore drains queue → red_test → seed.
- **S4 seed**: in-repo adaptation from external-eval-style signals; only xiocode changes.
- **Verifier**: default `npm run check`; red → no merge ask.
- **CapabilityGate**: optional trusted `xio eval compare` boundary. Only `PASS` may proceed to MergeGate ask; concerns/fail/infra stop before the ask.
- Details: [docs/self-improve.md](./docs/self-improve.md).

## Tools

- Builtin: `read`, `write`, `edit`, `bash`, `grep`, `glob`, `plan`.
- Optional: `explore` when `[explore] enabled` (read-only multi-subagent research).
- **Plan board**: `plan` tool writes `.claude/plan/{prd.md,implement.md,tasks.json}` (+ optional `tasks.csv`; legacy `.xiocode/plan` readable); TUI sticky **tasklist** widget; `/plan` refreshes.
- **Agent config**: Claude Code layout (`.claude/`, `~/.claude/`, root `CLAUDE.md`/`AGENTS.md`). `~/.xiocode` holds runtime state only (not skills/rules).
- Hygiene: `skill` (list/load local `SKILL.md`); MCP tools as `mcp__<server>__<tool>`.
- **Not shipped**: `search_context`, pi-ace-tool, `/ace-*`, full context compaction, process-interruption execution/file checkpoint-resume. Ink core, TUI diff confirmation/session bypass, persistent chat resume/picker, session-baseline `/rollback`, and latest-turn `/rollback turn` are shipped.

## Decision history (short)

- **Tag protocol** — rejected (multi-param tools + narrative ambiguity).
- **Reasonix fork** — rejected (MCP cannot observe agent loop).
- **pi-agent base** — superseded by ADR 0002 (own the runtime).
- **Docker / PathGuard / PermissionEngine** — removed in favor of outer worktree + MergeGate.
