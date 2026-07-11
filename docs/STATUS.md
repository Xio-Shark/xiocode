# XioCode Status

> Single delivery snapshot. Updated 2026-07-11 (agents_md + skills + user hooks + MCP client + harness throughput H1–H5 + trusted capability / regress MVP).
> Product endpoint: [GOAL.md](./GOAL.md). Near-term: [ROADMAP.md](../ROADMAP.md).

## Shipping

- Self-owned TypeScript runtime (`src/runtime`)
- CLI + TOML config (`providers`, `worktree`, extension on/off)
- Builtin tools: read / write / edit / bash / grep / glob
- Outer worktree sandbox + MergeGate (`xio-sandbox`)
- Self-improve outer loop (`xio-improve` / `xio improve`) — T4 + verifier + merge-ask
- Trusted local capability baseline (`xio eval`) — versioned reports, 5 dev/holdout families, external hidden graders, preflight/smoke/compare
- User-confirmed private regression capture (`xio regress`) — versioned local cases, evidence hashes, pinned-base red preflight
- Private before/candidate compare (`xio regress compare`) — same frozen verifier on before + candidate; `FIXED` / `STILL_RED` / `INVALID_CASE` / `INFRA_ERROR`; does not authorize MergeGate
- Opt-in self-improve capability gate (`xio improve --capability-gate`) — only trusted `PASS` can reach MergeGate ask
- Default evolve path: TrajectoryRecorder, RunStore, ResultDenoiser, ContextInjector, TodoEnforcer
- **AGENTS.md / CLAUDE.md injection** (`xio-hygiene`): in-place load of project + global specs (`~/.claude/CLAUDE.md`, `~/.xiocode/AGENTS.md`, `./CLAUDE.md`, `./AGENTS.md`) into system prompt via `before_agent_start`; bounded `@` imports + cycle detection; `config.toml` `[agents_md]` kill-switch. Not a full Claude Code nested-memory / auto-memory clone.
- **Skills discovery** (`xio-hygiene`): in-place scan of `.claude/skills/**/SKILL.md`, `~/.claude/skills/**/SKILL.md`, `.cursor/skills/**/SKILL.md` (+ optional `~/.xiocode/skills`); registers `skill` tool (`action=list|load`); system prompt gets short catalog only (name + description), full body on demand with truncation + hash; `config.toml` `[skills]` kill-switch / source flags. Not a Claude plugins market or skill-embedded-hooks clone.
- **User hooks** (`xio-hygiene`): Claude-compatible subset from `.claude/settings.json` / `~/.claude/settings.json` (+ `.local`); MVP events `SessionStart` → `session_start`/`before_agent_start`, `PreToolUse` → `tool_call` (exit 2 block), `PostToolUse` → `tool_result`, `Stop` → `agent_end`/`session_end`; command handlers only; unsupported events warn; `config.toml` `[hooks]` kill-switch / timeout. Not a full Claude hooks (~30 events) or http/prompt/agent handler clone.
- **MCP client** (`xio-hygiene`): tools-first client for `.mcp.json` + `~/.claude.json` `mcpServers` + `~/.cursor/mcp.json` + `config.toml` `[mcp]` overrides; transports **stdio / SSE / Streamable HTTP**; tools registered as `mcp__<server>__<tool>` (normal `registerTool`, PreToolUse-blockable); `session_end` closes stdio/HTTP; fail-open skip+warn by default (`fail_closed` optional). **Not** full resources/prompts workflows, OAuth browser flow, or MCP marketplace.
- Provider usage normalization (input/output/cache/reasoning tokens; unknown values stay `null`)
- Secret redaction in trajectories
- Light regex file outline (no tree-sitter)
- **Harness throughput (H1–H5)**: provider `completeStream` (OpenAI/Anthropic SSE), parallel tool scheduling (read/bash parallel; write/edit serial), multi-turn session history with `max_session_messages` trim notice, ContextInjector `turn_start` wiring into provider messages, AbortSignal through loop/client/bash + TUI Ctrl+C cancel turn
- **Ink TUI core** (GOAL G11 partial): TTY interactive sessions use an alternate-screen Ink shell with streamed assistant text, tool start/end rows, slash commands, model/busy/cwd status, and idle-exit/busy-cancel Ctrl+C semantics. `promptOnce` and non-TTY paths do not load Ink.
- **Session and turn rollback** (GOAL G5b): `/rollback` restores the immutable session-start commit; `/rollback turn` restores the Git file-tree checkpoint captured at the latest prompt boundary. Both use the TUI unified-diff confirmation, never reset the main tree, and retain conversation history.
- **TUI merge/rollback confirmation + bypass**: `/merge`, session finalize, and rollback asks stay inside Ink with scrollable diff context. `/bypass` auto-approves these asks for the current session only, shows `BYPASS` in status, and emits audit notices; new sessions default off.
- **Persistent chat sessions + resume**: `~/.xiocode/sessions/<id>/` stores validated metadata and messages separately from run evidence. `xio resume`, `xio --continue`, exact-id resume, and the TTY history picker restore model/chat context into a new worktree; corrupt records fail explicitly and can be deleted.

## Not on default path / not shipped

- StrategyLearner, PromptEvolver, and the old strategy-layer EvalComparator
- SpeculativeExecutor
- TrajectoryPlayer / HtmlExporter / `cli/replay`
- PrefixCacheAuditor, ActiveTools, provider-payload enhancer, parallel-tool-analyzer, context-compactor (full compaction algorithm still P1 / GOAL G4)
- Execution/file checkpoint-resume after process interruption (GOAL G5 remaining); chat resume is shipped, but old worktrees are not silently reopened
- pi-ace-tool / `search_context` / `/ace-*`
- PathGuard / PermissionEngine / Docker (deleted; worktree model instead)
- Root `contracts/` (archived to `docs/archive/contracts/` — no code consumers)
- Auto-merge on green verifier (revoked G4; do not resurrect)
- Credentialed real-model baseline result / public benchmark claim (no local `~/.xiocode/config.toml` for this delivery; see ROADMAP)
- Host-level process isolation for eval candidates (`host_isolation` is reported as `unsupported`)
- Automatic fixture minimization, or automatic run-to-improve routing
- Private case → `xio improve` joint gate (`--private-case`); compare is available but does not authorize MergeGate
- ripgrep-backed grep/glob (H6) and fuzzy/apply_patch edit (H8)
- Full Claude hooks surface (http/prompt/agent/mcp_tool handlers; non-MVP events)
- MCP resources/prompts full surface, OAuth browser auth, remote MCP marketplace

## Verify

```bash
npm run check
./test.sh
./bin/xio eval preflight --json
./bin/xio eval smoke --provider stub --json   # harness-only; not a capability claim
# xio regress create/preflight requires an existing local run and user verifier
```
