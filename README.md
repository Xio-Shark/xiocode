# XioCode 🦈

> A coding agent that lives in your terminal: **interrupt anytime, undo with one key, and never worry about broken codebases**.  
> Bring your own API key, runs 100% locally. No hosted relay, no data harvesting, every penny accounted for.

**中文版 → [README.zh-CN.md](./README.zh-CN.md)**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-22.6%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.0-informational.svg)](./package.json)
[![CI](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml/badge.svg)](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml)

---

## Why XioCode?

Most coding agents make promises about speed, but the real anxiety when using AI on real code isn't "is it fast enough?" It's:
- **Fear of dirty diffs**: What if it touches 10 files, breaks my tests, and leaves a mess?
- **Fragile sessions**: If your terminal dies or laptop sleeps mid-task, your entire context is wiped out.
- **Hidden costs and clunky provider setups**: Juggling custom proxy configs and guessing usage.

**XioCode is built to solve these daily headaches:**

```
┌────────────────────────────────────────────────────────┐
│                     Your Terminal                      │
│                                                        │
│  $ xio "refactor the payment module and add Stripe"    │
│                                                        │
│  XioCode:                                              │
│    · Takes a snapshot of your files before touching    │
│    · Reads and understands the project structure       │
│    · Edits files live, showing exact diffs             │
│    · Stops and asks before dangerous commands          │
│                                                        │
│  Don't like the changes? Type `/rollback turn` to undo │
│  Terminal died? Run `xio resume` to pick right back up │
└────────────────────────────────────────────────────────┘
```

---

## Three Core Superpowers

### 1. 💊 True "Regret Medicine" — Instant Undo
No need to manually sift through `git diff` when the agent goes off track:
- **Undo just the last turn**: Type `/rollback turn` to instantly revert files touched in that turn, without wiping your existing uncommitted work!
- **Undo the entire session**: Type `/rollback` to reset back to the state when `xio` first opened.

### 2. ⚡ Unbreakable Sessions — Survives any crash or Ctrl+C
Laptop battery died? Pressed `Ctrl+C` by mistake?  
Every step is safely journaled locally:
```bash
$ xio resume        # Reopens right where it stopped — full conversation, task state, and thoughts intact!
```

### 3. 🌏 First-class Models & Transparent Costs
Native support for **DeepSeek, Qwen (Aliyun DashScope), SiliconFlow, Zhipu AI (GLM)**, alongside **OpenAI, Claude, and Gemini**.  
The footer shows your exact spend in **real dollars and cents** on every turn — no fake `$0` placeholders.

---

## Quick Install

Requires **Node.js 22.6+** (the installer will guide you if needed).

```bash
# Recommended: one-line installer
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash

# Or install globally via npm
npm install -g @xioshark/xiocode
```

Pin a specific version:
```bash
export XIO_INSTALL_VERSION=1.3.0
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
```

Once installed, you get both `xio` and `xiocode` commands.

---

## Quickstart in 3 Minutes

### 1. Open your project
```bash
cd your-project
xio
```

### 2. Connect your API Key
If you don't have a key set up yet, type:
```text
/connect
```
Select your provider (DeepSeek, SiliconFlow, OpenAI, etc.) and paste your key. It's stored securely on your machine — no need to fiddle with `.env` or shell configs again.

### 3. Tell it what to build
```text
> Add an authentication middleware with JWT verification, input validation, and unit tests
```

Helpful tips:
- **Interrupt & steer**: Press Enter or type `!your text` while the agent is writing to steer it mid-turn.
- **Mention files**: Type `@filename` to fuzzy-search and feed files into context.
- **Shortcuts**: Press `?` on an empty line to view the full cheat sheet.

---

## Terminal TUI + Web Console

- **Fullscreen Terminal TUI** (`xio`): Markdown highlights, smooth mouse scrolling, `Ctrl+P` command palette, `Ctrl+F` search.
- **Local Web Console** (`xio web`): Opens a lightweight, zero-dependency timeline dashboard at `http://localhost:3000` to review turns, tools, and trajectories in a clean visual waterfall.

---

## Common Commands

### CLI Commands
| Command | What it does |
|---------|--------------|
| `xio` | Interactive terminal coding session |
| `xio "task description"` | One-shot prompt (runs and exits) |
| `xio resume` | Resume previous session |
| `xio web` | Launch local web console (`http://localhost:3000`) |
| `xio doctor` | Self-check Node version, keys, config, and provider connectivity |
| `xio models` | View provider catalog and model pricing table |

### In-Session Commands (Type `/`)
| Slash Command | What it does |
|---------------|--------------|
| `/connect` | Setup or switch provider API key |
| `/model` | Switch model on the fly |
| `/rollback turn` | **Undo turn**: revert files modified in the last prompt |
| `/rollback` | **Undo session**: revert files to session baseline |
| `/compact` | Compress conversation history when context gets large |
| `/help` | Open shortcut sheet (or press `?`) |

---

## Privacy & Safety

1. **No Cloud Relay**: XioCode does not run a hosted relay. API calls go directly from your machine to your configured provider.
2. **Zero Telemetry**: No background tracking of your code, prompts, or keystrokes. State stays under `~/.xiocode/`.
3. **Dangerous Command Safeguard**: Commands like `rm -rf` are intercepted and require your explicit confirmation before running.

---

## License

**[MIT](./LICENSE)** — Free and open source. Code written with XioCode is 100% yours forever.
