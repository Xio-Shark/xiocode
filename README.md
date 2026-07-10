# XioCode

> A local-first AI coding agent with a self-owned TypeScript runtime, outer git worktree isolation, and run evidence recording.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## What it is

XioCode is a terminal coding agent. The agent loop, builtin tools, and LLM clients live under `src/runtime` — not a thin wrapper around another agent product (see [ADR 0002](./docs/adr/0002-remove-pi-agent.md)).

| Capability | Status |
|------------|--------|
| Self-owned runtime (`src/runtime`) | ✅ |
| Builtin tools: read / write / edit / bash / grep / glob | ✅ |
| Outer worktree sandbox + MergeGate | ✅ |
| Trajectory recording (`~/.xiocode/runs/`) | ✅ |
| Result denoising + context injection | ✅ |
| Secret redaction in trajectories | ✅ |
| Self-improve outer loop (`xio improve`) | ✅ MVP — merge-ask only |
| Strategy self-iteration loop | ❌ not on default path |
| Semantic search (`search_context` / ace) | ❌ not shipped |
| Speculative prefetch / replay UI | ❌ removed from delivery |

---

## Quick Start

```bash
git clone https://github.com/xioshark/xiocode.git
cd xiocode
npm install --ignore-scripts
npm run build
```

```bash
mkdir -p ~/.xiocode
cat > ~/.xiocode/config.toml << 'EOF'
[general]
default_provider = "deepseek"
default_model = "deepseek-chat"

[providers.deepseek]
kind = "openai"
base_url = "https://api.deepseek.com"
model = "deepseek-chat"
api_key_env = "DEEPSEEK_API_KEY"

[worktree]
enabled = true
retain_on_reject = false
EOF

export DEEPSEEK_API_KEY=sk-...
./bin/xio
```

Sessions require a git repo. The agent works in `~/.xiocode/worktrees/<repo_id>/<session_id>`; merge into the main tree only after `/merge` (or session-end) confirmation.

---

## Architecture

```
src/cli            # xio CLI, config parser, extension wiring
src/runtime        # extension host, tools, providers, agent loop, REPL
extensions/
  xio-sandbox      # WorktreeSandbox + MergeGate
  xio-evolve       # TrajectoryRecorder + RunStore + Denoiser + ContextInjector
  xio-improve      # Self-improve runner (T4 + verifier + merge-ask)
docs/adr/          # Architecture decisions
docs/STATUS.md     # Current delivery status
```

Default `xio-evolve` path records runs and denoise/injects context. It does **not** register StrategyLearner, PromptEvolver, EvalComparator, SpeculativeExecutor, or ActiveTools.

`xio improve` runs the code self-modification outer loop inside a worktree. A green verifier only triggers a **MergeGate ask** — it never auto-merges into the main tree. See [docs/self-improve.md](./docs/self-improve.md).

Workspace writes stay inside the worktree via `assertInsideWorkspace` (no separate PathGuard / PermissionEngine / Docker layer).

---

## Commands

| Command | Source | Notes |
|---------|--------|-------|
| `/status` | xio-evolve | Runtime + current run |
| `/merge` | xio-sandbox | Diff summary + merge ask |
| `xio improve` | xio-improve | Self-improve loop; merge-ask only |

---

## Evidence

Runs land under `~/.xiocode/runs/<run_id>/` (`metadata.json`, `events.jsonl`, `trajectory.json`, …). Historical interop notes live in `docs/archive/contracts/` (archived; no runtime consumers).

---

## Docs

| Doc | Role |
|-----|------|
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

MIT
