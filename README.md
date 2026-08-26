# XioCode

> A coding agent that lives in your terminal, survives any crash, and never merges a line without you. Your key, your machine — orchestration stays local; only the context you send reaches the model you choose.

**中文版 → [README.zh-CN.md](./README.zh-CN.md)**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-22.6%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.0-informational.svg)](./package.json)
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

XioCode's orchestration, tool execution, session storage, and file edits run on your machine. XioCode does not operate a hosted request relay or a product-usage telemetry service.

To complete a request, XioCode sends the current model request directly to the provider endpoint you configure. That request can include your prompts, system and context instructions, tool definitions, and any file contents or tool results that have been added to the conversation. Your configured provider's data-handling terms apply.

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
          │  model request context
          │  (may include file contents and tool results)
          ▼
  ┌────────────────────────────────────┐
  │  THE MODEL (cloud)                 │
  │  DeepSeek · OpenAI ·               │
  │  Anthropic · Gemini ...            │
  │                                    │
  │  receives the request context      │
  │  selected for the model call       │
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

2. **Local runtime, bring your own provider.** Resumable sessions and run artifacts are stored on your machine by default. Model requests go to the provider endpoint you configure; XioCode does not operate a request relay or product-usage telemetry service. Any API key you already have works: DeepSeek, OpenAI, Anthropic, OpenRouter, Google Gemini, or any service that speaks the OpenAI API.

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
export XIO_INSTALL_VERSION=1.3.0
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
- Everything stored locally under `~/.xiocode/` by default

Product goals: [docs/GOAL.md](./docs/GOAL.md) · delivery snapshot: [docs/STATUS.md](./docs/STATUS.md) · near-term: [ROADMAP.md](./ROADMAP.md)

---

## Local state

```
~/.xiocode/
├── config.toml          # Settings (no API keys here)
├── credentials.json     # API keys (never commit this!)
├── trust.json           # Project trust decisions
├── runs/                # Run history
├── sessions/            # Session history (resumable)
└── worktrees/           # Git worktree copies (optional)
```

By default, XioCode stores runtime state under `~/.xiocode/`; `XIO_*` variables and config settings can select other locations. These files can contain API keys, prompts, code excerpts, commands, tool output, configured headers, and project trust decisions. Treat the configured state directories as sensitive.

Local storage does not mean all processing is offline:

- **Model providers:** each model call sends its request context to the provider endpoint you configured. The context can include file contents and tool results when they are present in the conversation.
- **Update check:** normal agent startup may query npm for the latest XioCode version about once per 24-hour cache period. Set `XIO_DISABLE_UPDATE_CHECK=1` to disable it.
- **MCP and hooks:** remote MCP servers receive MCP requests and tool arguments. Stdio MCP servers and hooks run commands you configured; those commands may perform their own network activity.
- **Explicit checks:** `/connect`, `xio models`, and `xio doctor` may contact configured provider endpoints. Use `xio models --catalog-only` or `xio doctor --offline` for their no-network modes.

XioCode sends no product-usage analytics to a XioCode-operated service. This statement does not disable model-provider traffic, configured MCP servers or hooks, or the npm update check described above.

---

## License

**[MIT](./LICENSE)** — use it however you want.

At work, on proprietary code, forked, modified, bundled inside a closed-source product, or as the base of a paid service. No copyleft, no source-disclosure requirement, and no commercial license to buy. The one condition is that the copyright notice travels with substantial copies of the source.

The code you write *with* XioCode is yours, always.

---

## Questions / Feedback

Run `xio feedback` — it opens a GitHub page in your browser; XioCode does not submit the form or attach local data automatically. For bugs, attach the output of `xio doctor`: it contains everything needed to reproduce the problem, and no secrets.

- Issues: https://github.com/Xio-Shark/xiocode/issues
- Email: xioshark.0127@gmail.com

**No XioCode product telemetry.** XioCode does not send product-usage analytics to a XioCode-operated service. Model-provider traffic, configured MCP servers or hooks, and the optional npm update check are separate outbound paths described under [Local state](#local-state).
