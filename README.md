# XioCode

> A local-first AI coding agent with a self-owned TypeScript runtime, outer git worktree isolation, and run evidence recording.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg)](./LICENSE)

---

## What it is

XioCode is a terminal coding agent. The agent loop, builtin tools, and LLM clients live under `src/runtime` — not a thin wrapper around another agent product (see [ADR 0002](./docs/adr/0002-remove-pi-agent.md)).

**North star**: a local-first, self-owned coding-agent harness that is observable, rollback-safe, and self-improvable — with the user always holding merge consent. Full statement: [docs/GOAL.md](./docs/GOAL.md).

| Capability | Status |
|------------|--------|
| Self-owned runtime (`src/runtime`) | ✅ |
| Builtin tools: read / write / edit / bash / grep / glob | ✅ |
| Outer worktree sandbox + MergeGate | ✅ |
| Trajectory recording (`~/.xiocode/runs/`) | ✅ |
| Result denoising + context injection | ✅ |
| Provider streaming + parallel tools + multi-turn session | ✅ H1–H5 |
| Secret redaction in trajectories | ✅ |
| AGENTS.md / CLAUDE.md system-prompt injection | ✅ in-place + bounded `@` imports; not full Claude memory |
| Skills discovery (`skill` tool) | ✅ short catalog in prompt; load body on demand; `[skills]` config |
| User hooks (Claude settings subset) | ✅ SessionStart / PreToolUse / PostToolUse / Stop; `[hooks]` config |
| MCP client (tools-first) | ✅ deferred parallel connect; `.mcp.json` + Claude/Cursor; stdio/SSE/HTTP; `mcp__*`; `[mcp]` |
| Agent modes (`/agent` build\|plan) | ✅ plan denies write/edit/bash/MCP; status shows mode + risks |
| `xio models` | ✅ catalog (+ discovery) lines; no worktree session |
| Self-improve outer loop (`xio improve`) | ✅ MVP — merge-ask only |
| Trusted local capability baseline (`xio eval`) | ✅ preflight / smoke / compare |
| Private regression capture (`xio regress`) | ✅ `/regress` + `capture --last`; user verdict + base-red preflight + compare |
| Session and turn rollback (`/rollback`, `/rollback turn`) | ✅ diff preview + confirmation; files reset, chat retained |
| Persistent chat session resume (`~/.xiocode/sessions/`) | ✅ latest/id/picker restore; v2 sessions reattach the validated original worktree |
| Context compaction (`/compact [focus]`) | ✅ same-provider continuation summary; automatic message-budget trigger; persisted resume marker |
| Execution/file checkpoint-resume | ✅ atomic session state; original worktree attach; interrupted tools are not replayed |
| Ink / React interactive TUI core | ✅ TTY transcript, stream/thinking/tool preview, slash commands, Claude-quiet theme tokens, Ctrl+C cancel |
| TUI diff confirmation + session bypass | ✅ unified diff modal for merge/rollback/finalize; `/bypass` is session-only |
| TUI session picker / resume | ✅ `xio resume`, `xio resume <id>`, `xio resume --list`, `--continue` |
| Strategy self-iteration loop | ❌ not on default path |
| Semantic search (`search_context` / ace) | ❌ not shipped |
| Speculative prefetch / replay UI | ❌ removed from delivery |

---

## Install (once, like Claude Code)

Requires **Node.js ≥ 22.6** (uses `--experimental-strip-types`).

```bash
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
```

Or with npm directly:

```bash
npm install -g github:Xio-Shark/xiocode
```

Then from **any git repository**:

```bash
export DEEPSEEK_API_KEY=sk-...   # or run /connect inside the TUI
xio          # Ink TUI
# or
xiocode      # same binary
```

First run creates `~/.xiocode/config.toml` if missing (`xio init` does the same). API keys go in env or `~/.xiocode/credentials.json` via `/connect` — never in `config.toml`. Sessions always start in a worktree under `~/.xiocode/worktrees/`; merge into the main tree only after `/merge` (or session-end) confirmation.

### Develop from a local checkout

```bash
git clone https://github.com/Xio-Shark/xiocode.git
cd xiocode
npm install --ignore-scripts
npm link    # registers xio / xiocode / xio-improve on PATH
```

Without linking: `./bin/xio` from the checkout.

---

## Architecture

```
src/cli            # xio CLI, config parser, extension wiring
src/runtime        # extension host, tools, providers, agent loop, session UI sink
src/tui            # Ink interactive shell (runtime remains React-free)
extensions/
  xio-sandbox      # WorktreeSandbox + MergeGate
  xio-evolve       # TrajectoryRecorder + RunStore + Denoiser + ContextInjector
  xio-hygiene      # AGENTS.md / CLAUDE.md + skills + user hooks + MCP client
  xio-improve      # Self-improve runner (T4 + verifier + merge-ask)
  xio-eval         # Trusted fixtures, hidden graders, before/after gate
  xio-regress      # Private run capture + zero-model base-red preflight
docs/adr/          # Architecture decisions
docs/GOAL.md       # Final product goal (north star)
docs/STATUS.md     # Current delivery status
docs/self-improve.md
docs/archive/      # Historical plans / contracts
```

Default `xio-evolve` path records runs and denoise/injects context. It does **not** register StrategyLearner, PromptEvolver, the old strategy-layer EvalComparator, SpeculativeExecutor, or ActiveTools.

Harness throughput on the default path: provider streaming (`completeStream`), parallel tool scheduling (read/bash parallel; write/edit serial), TUI multi-turn history with transactional context compaction, ContextInjector output merged into provider messages, and AbortSignal / Ctrl+C cancel for the current turn.

`xio improve` runs the code self-modification outer loop inside a worktree. A green verifier only triggers a **MergeGate ask** — it never auto-merges into the main tree. See [docs/self-improve.md](./docs/self-improve.md).

`xio eval` runs its controller and hidden graders outside the candidate fixture worktree. `preflight` is zero-model; `smoke` runs five held-out TypeScript families; `compare` uses one frozen suite for before/candidate and repeats differing cases. Use `--candidate-mode real|stub`, optional `--model provider/model`, and `--repeat N` for credentialed series (`credentialed-series.v1`). Real mode loads `/connect` credentials and discloses only the selected provider key to the child. Stub mode validates wiring only and returns `PASS_WITH_CONCERNS`, never a capability claim.

`xio regress` turns a run into a local case only after the user supplies a failure statement and executable verifier. New runs keep a `SecretRedactor`-sanitized replay prompt in `prompt.json`; cases freeze its reference and hashes without copying the text. Its preflight checks the pinned base is red in a temporary worktree. `xio regress compare` runs the same frozen verifier on a before root and a candidate checkout (`FIXED` / `STILL_RED`); neither proves trusted capability nor authorizes merge.

Workspace writes stay inside the worktree via `assertInsideWorkspace` (no separate PathGuard / PermissionEngine / Docker layer).

### Skills discovery

`xio-hygiene` scans local `SKILL.md` files in place (no plugin market):

| Root | Flag |
|------|------|
| `.claude/skills/**/SKILL.md` | `[skills].read_claude` |
| `~/.claude/skills/**/SKILL.md` | `[skills].read_claude` |
| `.cursor/skills/**/SKILL.md` | `[skills].read_cursor` |
| `~/.xiocode/skills/**/SKILL.md` | always on when skills enabled |

Same-name priority: project `.claude` > project `.cursor` > `~/.xiocode/skills` > `~/.claude/skills`. System prompt gets a short catalog (name + description only). Full body is loaded via the `skill` tool:

| Param | Values |
|-------|--------|
| `action` | `list` (JSON catalog) or `load` (body + hash; truncated by `max_body_bytes`) |
| `name` | required for `load` |

Disable with `[skills] enabled = false` in `~/.xiocode/config.toml`.

### User hooks

`xio-hygiene` reads Claude-compatible hooks from settings files (project overrides user per event):

| Path | Notes |
|------|-------|
| `~/.claude/settings.json` | user |
| `~/.claude/settings.local.json` | user local |
| `.claude/settings.json` | project |
| `.claude/settings.local.json` | project local |

MVP events mapped to ExtensionHost:

| Claude | Xio event | Behavior |
|--------|-----------|----------|
| `SessionStart` | `session_start` (+ prompt via `before_agent_start`) | stdout / `additionalContext` → system prompt |
| `PreToolUse` | `tool_call` | exit `2` (or JSON deny) blocks the tool |
| `PostToolUse` | `tool_result` | side effects; non-blocking errors continue |
| `Stop` | `agent_end` / `session_end` | side effects |

Only `type: "command"` handlers run (stdin JSON → stdout/stderr). Unsupported events and handler types warn and are skipped. Default timeout is 5s via `[hooks].timeout_ms`; Claude settings `timeout` is seconds (converted to ms). Failures continue except PreToolUse block.

```toml
[hooks]
enabled = true
read_claude = true
timeout_ms = 5000
```

### MCP client

`xio-hygiene` starts MCP connections in the **background** after `session_start` so the interactive prompt is not blocked. Servers connect **in parallel** (per-server `timeout_ms`); tools hot-register as `mcp__*` when ready (usable on the next turn). Status/notify surfaces connecting / ready / failed. Connections close on `session_end`.

| Source | Flag |
|--------|------|
| `~/.claude.json` → `mcpServers` | `[mcp].read_claude` |
| `~/.cursor/mcp.json` → `mcpServers` | `[mcp].read_cursor` |
| Project `.mcp.json` | always on when MCP enabled |
| `config.toml` `[mcp.servers.*]` | always on when MCP enabled (overrides same name) |

Merge order (later wins): Claude user → Cursor user → project `.mcp.json` → config.toml.

Transports:

| Kind | Config shape |
|------|----------------|
| stdio | `command` / `args` / `env` / `cwd` |
| SSE | `url` + `type`/`transport` = `sse` (+ optional `headers`) |
| HTTP (Streamable) | `url` + `type`/`transport` = `http` / `streamable-http` (+ optional `headers`) |

Tool names: `mcp__<server>__<tool>`. MVP is **tools-first** — resources/prompts are not a full workflow. Connection failures default to skip + warn (`fail_closed = true` to hard-fail after that server’s attempt).

```toml
[mcp]
enabled = true
read_claude = true
read_cursor = true
fail_closed = false
timeout_ms = 30000
```

---

## Commands

| Command | Source | Notes |
|---------|--------|-------|
| `/connect` | runtime | Select provider, enter API key (saved to `~/.xiocode/credentials.json`), validate, use immediately |
| `/model` | runtime | Switch session model among connected providers; updates config defaults |
| `/thinking` (`/effort`) | runtime | Set thinking effort (`off`…`ultra`); Tab cycles; persists `general.default_thinking_level` |
| `/agent` | runtime | Session mode `build` (default, full tools) or `plan` (read/grep/glob/skill; deny write/edit/bash/MCP) |
| `/regress` | runtime | Capture private case from current run (prompts failure + verifier; auto-preflight) |
| `/compact [focus]` | runtime | Summarize older complete turns with the active provider/model; visible, cancellable, persisted, and never silently trims on failure |
| `/status` | xio-evolve + runtime | Runtime + current run; includes `agent` mode, risk classes, `high_risk_policy`, `host_isolation: unsupported` |
| `/merge` | xio-sandbox | Diff summary + merge ask |
| `/rollback` | runtime + xio-sandbox | Preview and discard all session worktree changes; main tree and chat history stay untouched |
| `/rollback turn` | runtime + xio-sandbox | Restore the file tree captured at the start of the latest prompt; earlier-turn files and chat stay intact |
| `xio models` | CLI | List `provider/model` lines from catalog (+ discovery when keys exist); no worktree |
| `xio improve` | xio-improve | Self-improve loop; merge-ask only |
| `xio improve --capability-gate` | xio-improve + xio-eval | Trusted compare must PASS before merge ask |
| `xio eval preflight` | xio-eval | Zero-model fixture/oracle/tamper validation |
| `xio eval smoke` | xio-eval | Held-out tasks; `--candidate-mode` / `--model` / `--repeat`; credentialed series |
| `xio eval compare` | xio-eval | Paired before/candidate evidence |
| `xio regress capture` | xio-regress | Low-friction create (`--last`, default failure type) |
| `xio regress create` | xio-regress | Capture explicit user verdict + frozen verifier |
| `xio regress preflight` | xio-regress | Zero-model pinned-base red check |
| `xio regress compare` | xio-regress | Private before/candidate verifier compare |

---

## Evidence

Runs land under `~/.xiocode/runs/<run_id>/` (`metadata.json`, `events.jsonl`, `trajectory.json`, `provenance.json`, `prompt.json`, …). `prompt.json` contains the redacted replayable prompt and a hash of that exact content. Private cases reference these artifacts from `~/.xiocode/regressions/<case_id>/case.json`; they copy neither prompt text nor trajectories. Legacy runs are replayable only when one user prompt can be recovered unambiguously from the trajectory. Historical interop notes live in `docs/archive/contracts/` (archived; no runtime consumers).

Interactive sessions persist atomic `~/.xiocode/sessions/<session_id>/state.json` records with model, messages, workspace identity, execution phase, and durable turn checkpoint. `xio resume` restores the latest session for the current repository, `xio resume <id>` restores an exact record, `xio resume --list` opens the history picker, and `xio resume --delete <id>` removes a bad or unwanted record. A v2 interrupted session reattaches its validated original worktree; uncertain tool calls are marked `completion unknown` and are never replayed automatically. Legacy v1 chat-only sessions remain loadable and start a new isolated worktree. Resume does not reuse `runs/` evidence or weaken MergeGate.

Eval reports land under `~/.xiocode/evals/<eval_id>/` and reference the existing run id/trajectory instead of copying a second trajectory store. Provider token usage is normalized at the runtime client boundary; unavailable fields remain `null`. Cost is calculated only when `--price-table PATH` or `XIO_EVAL_PRICE_TABLE` supplies a versioned trusted price table.

---

## Docs

| Doc | Role |
|-----|------|
| [docs/GOAL.md](./docs/GOAL.md) | **Final product goal (north star)** |
| [CONTEXT.md](./CONTEXT.md) | Domain glossary |
| [docs/STATUS.md](./docs/STATUS.md) | Honest delivery status |
| [docs/self-improve.md](./docs/self-improve.md) | Self-modify loop + merge-ask |
| [ROADMAP.md](./ROADMAP.md) | Near-term priorities |
| [docs/adr/](./docs/adr/) | ADRs |
| [docs/archive/](./docs/archive/) | Historical plans / contracts |

---

## Development

```bash
npm run check
./test.sh
```

TypeScript is erasable-only (Node strip-only). See [AGENTS.md](./AGENTS.md).

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE).

- **Personal / noncommercial use**: free under this license (study, hobby, research, education, etc.).
- **Commercial use**: not covered; contact the maintainers for a separate commercial license via [GitHub Issues](https://github.com/Xio-Shark/xiocode/issues) or the [Xio-Shark](https://github.com/Xio-Shark) organization.
