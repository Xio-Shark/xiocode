# XioCode

> A coding agent that lives in your terminal, survives any crash, and never merges a line without you. Your key, your machine, your code — nothing leaves.

**中文版 → [README.zh-CN.md](./README.zh-CN.md)**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-22.6%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.2.0-informational.svg)](./package.json)
[![CI](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml/badge.svg)](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml)

---

## What is XioCode?

```
  ┌────────────────────────────────────┐
  │          Your Terminal             │
  │                                    │
  │  $ xio "add a login page"          │
  │                                    │
  │  XioCode:                          │
  │    → reads your project            │
  │    → understands the code          │
  │    → edits files                   │
  │    → runs commands                 │
  │    → shows you every change        │
  │      it makes                      │
  │                                    │
  │  Result: project is updated.       │
  └────────────────────────────────────┘
```

XioCode is a **coding agent that runs on your machine**, inside the project folder you launch it from. There is no XioCode cloud, no account to create, and nothing to upload — the code stays exactly where it already is.

The only thing that ever leaves your computer is the conversation you send to a model API — and that request goes **straight from you to the provider**, not through any middleman:

```
  ┌────────────────────────────────────┐
  │          YOUR MACHINE              │
  │                                    │
  │  your code                         │
  │    │ reads                         │
  │    ▼                               │
  │  XioCode (runs locally)            │
  │    │ edits                         │
  │    ▼                               │
  │  your code — now changed           │
  └───────┬────────────────────────────┘
          │  conversation (text only)
          ▼
  ┌────────────────────────────────────┐
  │  THE MODEL (cloud)                 │
  │  DeepSeek · OpenAI ·               │
  │  Anthropic · Gemini ...            │
  │                                    │
  │  sees only what you send —         │
  │  never your files or secrets       │
  └────────────────────────────────────┘
```

**Three reasons to use it:**

1. **Sessions that survive anything.** XioCode writes a journal entry before every step it takes. Kill the process mid-task, lose the terminal, lose power: `xio resume` reopens the session exactly where it stopped, with the full conversation and task state intact. In worktree mode, `/rollback` also undoes the file changes.

```
  "refactor payments" ──► step 1 ──► step 2 ──► crash!
                                                     │
                                                     ▼
                $ xio resume                          
                reopens right where                   
                it stopped — nothing lost             
```

2. **Local and private, with your own key.** No telemetry, no account, no middleman. Session history lives in `~/.xiocode/` and nowhere else. Any API key you already have works: DeepSeek, OpenAI, Anthropic, OpenRouter, Google Gemini, or any service that speaks the OpenAI API.

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
export XIO_INSTALL_VERSION=1.2.0
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
export DEEPSEEK_API_KEY=sk-xxxxx   # or run /connect inside the app instead
xio
```

No key yet? Start anyway — the session opens and walks you through `/connect`, which stores the key locally so you never touch an environment variable again.

```
  xio
   │
   ▼
  ┌──────────────────────────────────┐
  │  Welcome!                        │
  │                                  │
  │  Try: /connect to set API        │
  │  Or: just type your task         │
  │                                  │
  │  > "add error handling to        │
  │    the payment module"           │
  └──────────────────────────────────┘
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

**How much separation do you want?** You pick:

```
  DIRECT MODE (default)          WORKTREE MODE (opt-in)
  ┌──────────────────────┐            ┌────────────────────────┐
  │  your project        │            │  your project          │
  │  agent edits here    │            │  ▲                     │
  │  directly            │            │  │ /merge — when       │
  │  changes land now    │            │  │ you say so          │
  └──────────────────────┘            └────────────────────────┘
```

1. **Direct (default):** XioCode edits the directory you launched it from. No git required — a brand-new `git init` folder works too.
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

Inside the app:

| Command | What it does |
|---------|--------------|
| `/connect` | Set up an API key |
| `/model` | Switch model |
| `/merge` | Review and merge (worktree mode) |
| `/rollback` | Undo session or turn file changes (worktree mode) |
| `/compact` | Compress conversation context |
| `/help` | Open the shortcut sheet (or press `?`) |

Type `/` to browse every command, `@path` to bring a file into the conversation, and `?` on an empty prompt for the full key map.

While a turn is running: press Enter or type `!text` to steer the agent mid-task; `>>text` queues a follow-up for when the current turn finishes. `Esc` cancels the turn and keeps whatever you were typing. When idle, `Ctrl+C` clears the draft, and a second `Ctrl+C` on an empty prompt exits.

---

## What ships in the box

- A built-in agent with its own tools: `read` / `write` / `edit` / `bash` / `grep` / `glob`
- A terminal interface where answers appear as they are generated, live tool output is visible, markdown renders, and cost is shown in real dollars
- Crash-safe sessions: every step is journaled and checkpointed, so `xio resume` and (in worktree mode) `/rollback` can pick up or undo cleanly
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
