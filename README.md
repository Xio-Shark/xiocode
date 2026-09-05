# XioCode 🦈

> A coding assistant in your terminal: **interrupt anytime, roll back edits cleanly, and keep your workspace intact**.  
> Direct official provider endpoints, 100% local execution. No hosted relay, no data harvesting, transparent real-time cost tracking.

**中文版 → [README.zh-CN.md](./README.zh-CN.md)**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-22.6%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.0-informational.svg)](./package.json)
[![CI](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml/badge.svg)](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml)

---

## Why XioCode?

Most coding agents make promises about speed, but in day-to-day engineering, the real friction points are:
- **Fear of uncontrolled edits**: When an agent modifies multiple files unexpectedly, unwinding changes manually is painful;
- **Vulnerable sessions**: Terminal exits, laptop sleep, or accidental interrupts destroy context and force you to start over;
- **Tedious provider setups & hidden costs**: Juggling custom proxy configs with no real-time visibility into actual spending.

**XioCode is designed to provide a safe, disciplined, and recoverable coding workflow:**

```
┌────────────────────────────────────────────────────────┐
│                     Your Terminal                      │
│                                                        │
│  $ xio "refactor the payment module and add Stripe"    │
│                                                        │
│  XioCode:                                              │
│    · Takes an automated workspace state snapshot       │
│    · Analyzes project structure and dependencies       │
│    · Applies file edits with clear diffs               │
│    · Stops and asks before dangerous commands          │
│                                                        │
│  Want to undo? Run /rollback turn to revert the turn   │
│  Session interrupted? Run xio resume to continue       │
└────────────────────────────────────────────────────────┘
```

---

## Key Features

### 1. Granular Rollback: Safe, Turn-by-Turn Revert
When code changes across multiple files do not match expectations, manual reversion is slow and error-prone.  
XioCode captures lightweight snapshots before every modification:
- **Revert the latest turn**: Run `/rollback turn` to instantly revert files changed in that specific prompt, leaving your other uncommitted work untouched;
- **Revert the entire session**: Run `/rollback` to reset workspace files back to the state when the session began.

### 2. Session Persistence: Resume Interrupted Work Seamlessly
If your laptop sleeps, the terminal is accidentally closed, or a long-running process is stopped, you do not need to reconstruct your context.  
XioCode journals each execution step incrementally:
```bash
$ xio resume        # Reloads the session with conversation history, tool state, and context intact
```

### 3. Native Model Integration & Real-Time Cost Tracking
Directly connects to leading LLM providers through their official APIs without requiring intermediary proxies:
- **Domestic & Open APIs**: DeepSeek, Qwen (Aliyun DashScope), SiliconFlow, Zhipu AI (GLM), etc.
- **Global APIs**: Anthropic Claude, OpenAI, Google Gemini, etc.

The terminal status bar displays live cost calculations based on exact token usage (accurate to the cent) on every turn.

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
| `/rollback turn` | **Undo turn**: revert files modified in the latest prompt |
| `/rollback` | **Full rollback**: revert all workspace files back to session baseline |
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
