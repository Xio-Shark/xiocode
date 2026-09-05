# XioCode 🦈

> A local-first terminal coding agent engineered for safety, recoverability, and cost transparency.  
> Direct official LLM endpoints, turn-by-turn file rollbacks, and crash-resilient session persistence.

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-22.6%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.0-informational.svg)](./package.json)
[![CI](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml/badge.svg)](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml)

---

## Features

- **Granular Workspace Rollbacks**: Automatically captures lightweight workspace snapshots before edits. Revert changes turn-by-turn (`/rollback turn`) or to the session baseline (`/rollback`) without disturbing unrelated uncommitted local diffs.
- **Crash-Resilient State Persistence**: Conversations, task graphs, and execution states are incrementally journaled locally. Resume any interrupted session seamlessly via `xio resume`.
- **Native Multi-Model Integration**: Connects directly to official provider APIs including DeepSeek, Qwen (Aliyun DashScope), SiliconFlow, Zhipu AI (GLM), Anthropic Claude, OpenAI, and Google Gemini. No proxy servers required.
- **Real-Time Token & Cost Metering**: Precise turn-by-turn expenditure calculation based on actual token usage and provider pricing, displayed continuously in the status bar.
- **Dual Interface Modes**: Full-featured terminal TUI with syntax highlighting, fuzzy search, and command palette, alongside a zero-dependency local Web console (`xio web`) for visual timeline inspections.
- **Built-in Execution Guardrails**: Intercepts destructive shell commands and unsafe file mutations, requiring explicit user authorization before execution.

---

## Requirements

- **Node.js**: 22.6.0 or higher
- **OS**: macOS, Linux, Windows (WSL)

```bash
# Recommended: Automated installer
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash

# Or install globally via npm
npm install -g @xioshark/xiocode
```

Pin a specific version:
```bash
export XIO_INSTALL_VERSION=1.3.0
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
```

Once installed, use either `xio` or `xiocode`.

---

## Quickstart

### 1. Launch a Session
Run inside any project directory:
```bash
xio
```

### 2. Connect Your Provider
On first launch, run:
```text
/connect
```
Select your provider and input your API key. Credentials are encrypted and stored locally under `~/.xiocode/`—never transmitted to third-party relays.

### 3. Assign Tasks
Describe your requirements directly in the prompt:
```text
> Implement a JWT authentication middleware with refresh token rotation and write comprehensive unit tests.
```

**Workflow Tips**:
- **Interrupt & Steer**: Press Enter or prefix with `!message` during generation to adjust instructions mid-flight.
- **Context Pinning**: Type `@` to fuzzy-search and inject relevant files into context.
- **Help Sheet**: Press `?` on an empty line to view keybindings.

---

## Core Workflows

### Reverting Changes (Rollback)
| Command | Scope | Description |
| :--- | :--- | :--- |
| `/rollback turn` | Single Turn | Reverts only files modified in the latest prompt, preserving existing local diffs |
| `/rollback` | Entire Session | Reverts all files modified throughout the session back to the initial baseline |

### Resuming Work (Resume)
If a session terminates unexpectedly due to battery drain, terminal closure, or `SIGINT`:
```bash
xio resume        # Restores the session with full context, task lists, and history
```

### Local Web Console
```bash
xio web           # Launches the lightweight visual console at http://localhost:3000
```
Inspect model interactions, tool call arguments, execution output, and timeline progression.

---

## Command Reference

### CLI Commands
| Command | Description |
| :--- | :--- |
| `xio` | Launch the interactive terminal coding environment |
| `xio "task description"` | Execute a one-shot task and exit upon completion |
| `xio resume` | Resume the most recent active or interrupted session |
| `xio web` | Launch the local web timeline console (`http://localhost:3000`) |
| `xio doctor` | Diagnose environment, configuration, and API connectivity |
| `xio models` | Display supported providers, models, and real-time pricing |

### In-Session Slash Commands
| Command | Description |
| :--- | :--- |
| `/connect` | Configure or switch provider API credentials |
| `/model` | Change active model on the fly |
| `/rollback turn` | Undo file changes made during the latest turn |
| `/rollback` | Undo all file changes made in the current session |
| `/compact` | Compress conversation history to optimize context window |
| `/clear` | Clear screen buffer and redraw active turn |
| `/help` | Display shortcuts and command manual |

---

## Security & Privacy

1. **Local-First Architecture**: API requests are dispatched directly from your machine to official provider endpoints. There are no proprietary relays or intermediary gateways.
2. **Zero Telemetry**: We do not collect or transmit source code, prompts, or interaction telemetry. All states remain strictly in `~/.xiocode/`.
3. **Execution Guardrails**: Unsafe file modifications and destructive shell commands (e.g., recursive removals) are paused for explicit human-in-the-loop approval.

---

## License

Distributed under the [MIT License](./LICENSE). All code generated using XioCode belongs entirely to you.
