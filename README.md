# XioCode

> A local-first AI coding agent for your terminal — reads code, edits files, runs commands, and keeps merge control with you.

**中文版 → [README.zh-CN.md](./README.zh-CN.md)**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-22.6%2B-green.svg)](https://nodejs.org/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.1.0-informational.svg)](./package.json)

---

## What is XioCode?

```
  ┌─────────────────────────────────────────────┐
  │            Your Terminal                     │
  │                                             │
  │  $ xio "add a login page"                   │
  │                                             │
  │  ┌─────────────────────────────────────┐    │
  │  │  XioCode reads your project         │    │
  │  │  → understands the code             │    │
  │  │  → edits files                      │    │
  │  │  → runs commands                    │    │
  │  │  → shows you a diff before merging  │    │
  │  └─────────────────────────────────────┘    │
  │                                             │
  │  Result: Your project is updated.           │
  └─────────────────────────────────────────────┘
```

XioCode is a **local AI coding agent** with a self-owned TypeScript runtime. It runs in your project folder on your machine — no cloud agent service, no code upload.

**Four product bets:**

| Bet | What it means |
|-----|---------------|
| **Fast** | Early-boot first frame, streaming TUI, cached discovery / provider schema |
| **On-task** | Plan / todo / mid-turn steer / follow-up / full tool results in context |
| **Zero-friction cwd** | Default = current directory; **git optional**; worktree **off** |
| **You own the merge** | Opt-in worktree + MergeGate; self-improve never auto-merges |

---

## Requirements

- **Node.js 22.6+** (with `--experimental-strip-types`)
- An API key for an LLM provider (DeepSeek, OpenAI, Anthropic, …)

---

## Quick Install

```bash
# One line (recommended)
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
```

Or with npm:

```bash
npm install -g github:Xio-Shark/xiocode
```

Done. You get `xio` and `xiocode`.

---

## First Run

```bash
cd your-project
export DEEPSEEK_API_KEY=sk-xxxxx   # or any provider key
xio
```

Inside the TUI, `/connect` can store the API key locally (no env var required).

```
  xio
   │
   ▼
  ┌──────────────────────────────┐
  │  Welcome!                    │
  │                              │
  │  Try: /connect to set API    │
  │  Or: just type your task     │
  │                              │
  │  > "add error handling to    │
  │    the payment module"       │
  └──────────────────────────────┘
```

---

## How It Works

```
You type a task                    XioCode works
       │                                │
       ▼                                ▼
┌──────────────┐             ┌──────────────────────┐
│ "add a new   │             │ 1. Read your code    │
│  API route"  │ ──────────► │ 2. Plan changes      │
└──────────────┘             │ 3. Edit files        │
                             │ 4. Run commands      │
                             └──────────┬───────────┘
                                        │
                                        ▼
                             ┌──────────────────────┐
                             │ You review the diff  │
                             │                      │
                             │ ┌────────────────┐   │
                             │ │ + new route    │   │
                             │ │ + validation   │   │
                             │ └────────────────┘   │
                             │                      │
                             │ ✅ Approve           │
                             │ ❌ Reject            │
                             └──────────────────────┘
```

**Default path:** edit the launch directory directly. No git required. No sandbox.

**Extra safety (opt-in):** set `[worktree] enabled = true` in `~/.xiocode/config.toml`. XioCode works in a separate git worktree and only merges when you run `/merge`.

---

## Common Commands

| Command | What it does |
|---------|--------------|
| `xio` | Interactive session |
| `xio "do something"` | One-shot task (`-p` / non-interactive) |
| `xio init` | Create default config |
| `xio models` | List provider/model ids |
| `xio resume` | Resume a previous session |
| `xio improve` | Self-improve loop (worktree + verifier + merge ask) |
| `xio eval` | Trusted local capability preflight / smoke / compare |
| `xio regress` | Capture / preflight / compare private regressions |
| `xio bench` | Local performance fixtures (P50 / P95) |

Inside the TUI:

| Command | What it does |
|---------|--------------|
| `/connect` | Set up API key |
| `/model` | Switch model |
| `/merge` | Review and merge (worktree mode) |
| `/rollback` | Undo session or turn file changes |
| `/compact` | Compress conversation context |
| `/help` | Show all commands |

Composer tips while a turn is running: Enter / `!text` soft-steers; `>>text` queues a follow-up for the natural end of the turn. Use `@path` to mention files.

---

## What ships in the box

- Self-owned agent loop + tools: `read` / `write` / `edit` / `bash` / `grep` / `glob`
- Ink TUI: streaming answer, tool rows, markdown scrollback, usage footer
- Target-repo `CLAUDE.md` / skills / hooks / MCP (tools-first)
- Opt-in worktree sandbox + MergeGate; session / turn rollback
- Local evidence under `~/.xiocode/` — runs, sessions, evals, regress cases

Deeper product truth: [docs/GOAL.md](./docs/GOAL.md) · delivery snapshot: [docs/STATUS.md](./docs/STATUS.md) · near-term: [ROADMAP.md](./ROADMAP.md)

---

## Data Storage (all local)

```
~/.xiocode/
├── config.toml          # Settings (no API keys here)
├── credentials.json     # API keys (never commit this!)
├── trust.json           # Project trust decisions
├── runs/                # Run history
├── sessions/            # Session history (resumable)
├── worktrees/           # Git worktree copies (optional)
├── evals/               # Trusted eval reports
└── regressions/         # Private regression cases
```

Everything stays on **your machine**. No uploads, no cloud.

---

## License

**Dual-licensed: AGPL-3.0 OR Commercial License**

| Use case | License |
|----------|---------|
| Personal study, hobby, research | ✅ [AGPL-3.0](./LICENSE) (free) |
| Open-source project | ✅ [AGPL-3.0](./LICENSE) (free) |
| Commercial / proprietary product | ❌ Must purchase [Commercial License](./COMMERCIAL.md) |
| SaaS / cloud service | ❌ Must purchase [Commercial License](./COMMERCIAL.md) |

For commercial licenses, contact: **xioshark.0127@gmail.com**

---

## Questions / Feedback

- Issues: https://github.com/Xio-Shark/xiocode/issues
- Email: xioshark.0127@gmail.com
