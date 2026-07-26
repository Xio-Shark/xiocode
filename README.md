# XioCode

> A coding agent that lives in your terminal, survives any crash, and never merges a line without you. Your key, your machine, your code — nothing leaves.

**中文版 → [README.zh-CN.md](./README.zh-CN.md)**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-22.6%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.1.1-informational.svg)](./package.json)
[![CI](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml/badge.svg)](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml)

---

## What is XioCode?

```
  ┌─────────────────────────────────────────────┐
  │            Your Terminal                    │
  │                                             │
  │  $ xio "add a login page"                   │
  │                                             │
  │  ┌─────────────────────────────────────┐    │
  │  │  XioCode reads your project         │    │
  │  │  → understands the code             │    │
  │  │  → edits files                      │    │
  │  │  → runs commands                    │    │
  │  │  → shows you every change it makes  │    │
  │  └─────────────────────────────────────┘    │
  │                                             │
  │  Result: your project is updated.           │
  └─────────────────────────────────────────────┘
```

XioCode is a **local AI coding agent**. It works inside your project folder, on your machine. There is no cloud service in the middle and no upload step: the code stays where it already is.

**Three reasons to use it:**

1. **Sessions that survive anything.** XioCode writes a journal entry before every step it takes. Kill the process mid-task, lose the terminal, lose power: `xio resume` reopens the session exactly where it stopped, with the full conversation and task state intact. In worktree mode, `/rollback` also undoes the file changes.
2. **Local and private, with your own key.** No telemetry, no account, no middleman. Session history lives in `~/.xiocode/` and nowhere else. Any API key you already have works: DeepSeek, OpenAI, Anthropic, OpenRouter, Google Gemini, or any OpenAI-compatible endpoint.
3. **You own the merge.** By default XioCode edits your working directory and shows each change as it lands, and known-dangerous commands stop and ask before running. Turn on worktree mode and it works in a separate git copy instead — your tree stays untouched until you type `/merge`.

```bash
$ xio "refactor the payment module"
# ...agent is working... you hit Ctrl-C / the terminal dies / the laptop dies
$ xio resume        # picks up exactly where it left off
> /rollback         # worktree mode: undo this session's file changes entirely
```

---

## Requirements

- **Node.js 22.6+** (with `--experimental-strip-types`) — `install.sh` checks this and tells you how to upgrade
- An API key from any supported provider: DeepSeek, OpenAI, Anthropic, OpenRouter, Google Gemini, or a custom OpenAI-compatible gateway

**Supported platforms:**

| Platform | Status |
|----------|--------|
| macOS | ✅ Supported |
| Linux | ✅ Supported |
| Windows | ⚠️ Untested — use [WSL](https://learn.microsoft.com/windows/wsl/) |

---

## Quick Install

```bash
# One line (recommended) — installs @xioshark/xiocode from npm
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
```

Pin a version:

```bash
export XIO_INSTALL_VERSION=1.1.1
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
```

Or with npm directly:

```bash
npm install -g @xioshark/xiocode
```

Done. You get `xio` and `xiocode`.

---

## First Run

```bash
cd your-project
export DEEPSEEK_API_KEY=sk-xxxxx   # or run /connect inside the TUI instead
xio
```

No key yet? Start anyway — the session opens and walks you through `/connect`, which stores the key locally so you never touch an environment variable again.

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
                             │ You stay in charge   │
                             │                      │
                             │ · every edit and     │
                             │   command is shown   │
                             │ · dangerous commands │
                             │   stop and ask       │
                             │ · worktree mode adds │
                             │   a /merge gate      │
                             └──────────────────────┘
```

**The isolation ladder** — you choose how much separation you want:

1. **Direct (default):** XioCode edits the directory you launched it from. No git required; a brand-new `git init` folder works too.
2. **Worktree (opt-in):** set `[worktree] enabled = true` in `~/.xiocode/config.toml`. XioCode works in a separate git worktree, and its changes reach your tree only when you run `/merge`. This mode also unlocks `/rollback`.
3. **Container:** planned — tell us if you need it.

---

## Common Commands

| Command | What it does |
|---------|--------------|
| `xio` | Interactive session |
| `xio "do something"` | One-shot task, same as `xio -p "..."` |
| `xio init` | Create default config |
| `xio models` | List provider/model ids |
| `xio resume` | Resume a previous session |
| `xio doctor` | Self-check: Node version, config, keys, provider connectivity |
| `xio feedback` | Report a bug or request a feature (`--bug`, `--feature`) |

Inside the TUI:

| Command | What it does |
|---------|--------------|
| `/connect` | Set up an API key |
| `/model` | Switch model |
| `/merge` | Review and merge (worktree mode) |
| `/rollback` | Undo session or turn file changes (worktree mode) |
| `/compact` | Compress conversation context |
| `/help` | Show all commands |

While a turn is running: press Enter or type `!text` to steer the agent mid-task; `>>text` queues a follow-up for when the current turn finishes. Type `@path` to bring a file into the conversation.

---

## What ships in the box

- Its own agent loop and tools: `read` / `write` / `edit` / `bash` / `grep` / `glob`
- A terminal UI with streaming answers, live tool output, markdown rendering, and a running cost in real dollars
- Crash-safe sessions: journaled steps and checkpoints, `xio resume`, `/rollback` in worktree mode
- Reads your repo's `CLAUDE.md`, skills, hooks, and MCP servers
- Opt-in worktree isolation with an explicit `/merge` gate
- Everything stored locally under `~/.xiocode/`

Product goals: [docs/GOAL.md](./docs/GOAL.md) · delivery snapshot: [docs/STATUS.md](./docs/STATUS.md) · near-term: [ROADMAP.md](./ROADMAP.md)

---

## Data Storage (all local)

```
~/.xiocode/
├── config.toml          # Settings (no API keys here)
├── credentials.json     # API keys (never commit this!)
├── trust.json           # Project trust decisions
├── runs/                # Run history
├── sessions/            # Session history (resumable)
└── worktrees/           # Git worktree copies (optional)
```

Everything stays on **your machine**. No uploads, no cloud.

---

## License

**[MIT](./LICENSE)** — use it however you want.

At work, on proprietary code, forked, modified, bundled inside a closed-source product, or as the base of a paid service. No copyleft, no source-disclosure requirement, and no commercial license to buy. The one condition is that the copyright notice travels with substantial copies of the source.

The code you write *with* XioCode is yours, always.

---

## Questions / Feedback

Run `xio feedback` — it opens the right form from your terminal. For bugs, attach the output of `xio doctor`: it contains everything needed to reproduce the problem, and no secrets.

- Issues: https://github.com/Xio-Shark/xiocode/issues
- Email: xioshark.0127@gmail.com

**No telemetry.** XioCode never phones home with usage data, so what you report is the only signal there is — every issue gets a reply within 48 hours. One outbound request exists and deserves naming: about once a day, XioCode asks npm whether a newer version is available. `export XIO_DISABLE_UPDATE_CHECK=1` turns that off too.
