# XioCode

> An AI coding assistant that runs in your terminal — reads your code, edits files, runs commands.

**中文版 → [README.zh-CN.md](./README.zh-CN.md)**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)

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

XioCode is a **local AI coding agent** — it works directly in your project folder on your own machine. No cloud service, no data leaves your computer.

**Three key ideas:**

| Idea | What it means |
|------|--------------|
| 🏠 **Local-first** | Everything runs on your machine. Your code stays with you. |
| 👀 **You control merging** | XioCode shows you what it changed — you review, then approve. |
| 🔌 **Works with any project** | Git or not, any language, any framework. |

---

## Requirements

- **Node.js 22.6+** (with `--experimental-strip-types`)
- An API key for an LLM provider (DeepSeek, OpenAI, etc.)

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

Done. Now you have `xio` and `xiocode` commands.

---

## First Run

```bash
cd your-project
export DEEPSEEK_API_KEY=sk-xxxxx   # or any provider key
xio
```

Inside the terminal UI, you can also use `/connect` to set up your API key without environment variables.

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

XioCode works in **your current directory** directly by default. No sandbox, no git required.

If you want extra safety, enable **worktree isolation** in config — XioCode will work in a separate copy and only merge changes when you say `/merge`.

---

## Common Commands

| Command | What it does |
|---------|-------------|
| `xio` | Start interactive session |
| `xio "do something"` | One-shot task (non-interactive) |
| `xio init` | Create default config |
| `xio models` | List available models |
| `xio resume` | Resume last session |

Inside the TUI:

| Command | What it does |
|---------|-------------|
| `/connect` | Set up API key |
| `/model` | Switch model |
| `/merge` | Review and merge changes |
| `/rollback` | Undo all changes |
| `/compact` | Compress conversation context |
| `/help` | Show all commands |

---

## Data Storage (all local)

```
~/.xiocode/
├── config.toml          # Settings (no API keys here)
├── credentials.json     # API keys (never commit this!)
├── runs/                # Run history
├── sessions/            # Session history (resumable)
└── worktrees/           # Git worktree copies (optional)
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
