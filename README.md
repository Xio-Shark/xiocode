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
| Secret redaction in trajectories | ✅ |
| Self-improve outer loop (`xio improve`) | ✅ MVP — merge-ask only |
| Trusted local capability baseline (`xio eval`) | ✅ preflight / smoke / compare |
| Private regression capture (`xio regress`) | ✅ user verdict + base-red preflight |
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
  xio-eval         # Trusted fixtures, hidden graders, before/after gate
  xio-regress      # Private run capture + zero-model base-red preflight
docs/adr/          # Architecture decisions
docs/GOAL.md       # Final product goal (north star)
docs/STATUS.md     # Current delivery status
docs/self-improve.md
docs/archive/      # Historical plans / contracts
```

Default `xio-evolve` path records runs and denoise/injects context. It does **not** register StrategyLearner, PromptEvolver, the old strategy-layer EvalComparator, SpeculativeExecutor, or ActiveTools.

`xio improve` runs the code self-modification outer loop inside a worktree. A green verifier only triggers a **MergeGate ask** — it never auto-merges into the main tree. See [docs/self-improve.md](./docs/self-improve.md).

`xio eval` runs its controller and hidden graders outside the candidate fixture worktree. `preflight` is zero-model; `smoke` runs five held-out TypeScript families; `compare` uses one frozen suite for before/candidate and repeats differing cases. Stub mode validates wiring only and returns `PASS_WITH_CONCERNS`, never a capability claim.

`xio regress` turns a run into a local case only after the user supplies a failure statement and executable verifier. New runs keep a `SecretRedactor`-sanitized replay prompt in `prompt.json`; cases freeze its reference and hashes without copying the text. Its preflight checks the pinned base is red in a temporary worktree; this does not prove the failure is fixed and does not authorize merge.

Workspace writes stay inside the worktree via `assertInsideWorkspace` (no separate PathGuard / PermissionEngine / Docker layer).

---

## Commands

| Command | Source | Notes |
|---------|--------|-------|
| `/status` | xio-evolve | Runtime + current run |
| `/merge` | xio-sandbox | Diff summary + merge ask |
| `xio improve` | xio-improve | Self-improve loop; merge-ask only |
| `xio improve --capability-gate` | xio-improve + xio-eval | Trusted compare must PASS before merge ask |
| `xio eval preflight` | xio-eval | Zero-model fixture/oracle/tamper validation |
| `xio eval smoke` | xio-eval | Five held-out tasks; real provider by default |
| `xio eval compare` | xio-eval | Paired before/candidate evidence |
| `xio regress create` | xio-regress | Capture explicit user verdict + frozen verifier |
| `xio regress preflight` | xio-regress | Zero-model pinned-base red check |

---

## Evidence

Runs land under `~/.xiocode/runs/<run_id>/` (`metadata.json`, `events.jsonl`, `trajectory.json`, `provenance.json`, `prompt.json`, …). `prompt.json` contains the redacted replayable prompt and a hash of that exact content. Private cases reference these artifacts from `~/.xiocode/regressions/<case_id>/case.json`; they copy neither prompt text nor trajectories. Legacy runs are replayable only when one user prompt can be recovered unambiguously from the trajectory. Historical interop notes live in `docs/archive/contracts/` (archived; no runtime consumers).

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
