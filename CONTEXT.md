# XioCode Domain Glossary

> Resolved domain terms. No implementation dump.

---

## Product

- **XioCode**: local-first AI coding agent with a self-owned TypeScript runtime (`src/runtime`), outer worktree isolation, and run evidence under `~/.xiocode/runs/`.
- **`xio`**: CLI binary. Reads `~/.xiocode/config.toml`, starts the session/REPL, loads extensions in-process.
- **Harness**: layer between the LLM and the execution environment (tool calls ↔ file/shell actions).

## Architecture

- **Base strategy**: self-owned runtime under `src/runtime`. Historical pi-agent dependency removed ([ADR 0002](./docs/adr/0002-remove-pi-agent.md)).
- **Extension**: unit registered via `XioExtensionAPI` (`registerTool` / `registerCommand` / `on`). Lives under `extensions/`.
- **Language**: TypeScript (erasable-only).

## Extensions

- **xio-sandbox**: outer git worktree sandbox. `prepareLaunch` creates `~/.xiocode/worktrees/<repo_id>/<session_id>`; agent cwd points there. `/merge` and session-end use MergeGate.
- **xio-evolve** (default path): TodoEnforcer addendum, TrajectoryRecorder, RunStore, ResultDenoiser, ContextInjector. StrategyLearner / PromptEvolver / EvalComparator are **not** on the default path.
- **xio-improve**: self-modification outer loop (`xio improve` / `bin/xio-improve`). T4 GoalStore → worktree edits → verifier → **MergeGate ask**. Green verifier never auto-merges.

## Run evidence

- **Run**: one session, id `run_YYYYMMDD_HHMMSS`, stored at `~/.xiocode/runs/<run_id>/`.
- **Trajectory**: prompts, tool calls/results, todos, timing — `events.jsonl` + `trajectory.json`.

## Active infra (default path)

- **ResultDenoising** (ResultDenoiser): truncate long tool outputs; light regex outline for large source files; stack-trace truncation.
- **Dynamic Context Injection** (ContextInjector): inject git branch/status/recent commits for non-simple prompts.
- **Prompt classification**: tiny binary simple vs code classifier (optional model hint from config). Not a full multi-model router product.

## Safety & sandbox

- **WorktreeSandbox**: session-outer isolation; non-git dirs fail at launch (G0).
- **MergeGate**: diff summary + confirm before merging worktree branch into main tree; conflicts abort and keep worktree. Self-improve reuses the same gate — never “测绿即合”.
- **Workspace containment**: builtin `write`/`edit` use `assertInsideWorkspace` against worktree cwd. PathGuard / PermissionEngine / Docker were removed; do not reintroduce.
- **Config**: `[worktree] enabled` (default true), `retain_on_reject`.

## Self-improve

- **T4**: GoalStore drains queue → red_test → seed.
- **S4 seed**: in-repo adaptation from external-eval-style signals; only xiocode changes.
- **Verifier**: default `npm run check`; red → no merge ask.
- Details: [docs/self-improve.md](./docs/self-improve.md).

## Tools

- Builtin: `read`, `write`, `edit`, `bash`, `grep`, `glob`.
- **Not shipped**: `search_context`, pi-ace-tool, `/ace-*`.

## Decision history (short)

- **Tag protocol** — rejected (multi-param tools + narrative ambiguity).
- **Reasonix fork** — rejected (MCP cannot observe agent loop).
- **pi-agent base** — superseded by ADR 0002 (own the runtime).
- **Docker / PathGuard / PermissionEngine** — removed in favor of outer worktree + MergeGate.
