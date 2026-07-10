# Contributing to XioCode

> **Welcome!** XioCode is an open-source project that thrives on community contributions. Whether you're fixing a typo, adding a feature, or improving documentation, we appreciate your help.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Commit Messages](#commit-messages)
- [Pull Request Process](#pull-request-process)
- [Extension Development](#extension-development)

---

## Code of Conduct

Be respectful, constructive, and collaborative. We're all here to build something useful.

If you encounter harassment or abusive behavior, report it to the maintainers.

---

## How Can I Contribute?

### 1. Report Bugs

File a GitHub Issue with:

- **Title**: Short, descriptive (e.g., "TrajectoryRecorder crashes on empty tool result")
- **Reproduction steps**: Minimal example to reproduce
- **Expected behavior**: What should happen
- **Actual behavior**: What actually happens
- **Environment**: OS, Node.js version, XioCode version
- **Logs**: Relevant error messages or stack traces

### 2. Suggest Features

Before opening a feature request, check [ROADMAP.md](./ROADMAP.md) to see if it's already planned.

If not, open a GitHub Issue with:

- **Use case**: Why you need this feature
- **Proposed solution**: How you envision it working
- **Alternatives considered**: Other approaches you thought about

### 3. Fix Bugs or Implement Features

Check the [Issues page](https://github.com/xioshark/xiocode/issues) for:

- `good first issue` — Beginner-friendly tasks
- `help wanted` — Features or bugs we'd like community help on
- `P0` / `P1` / `P2` — Priority labels (see ROADMAP.md)

Comment on an issue to claim it before starting work.

### 4. Improve Documentation

Documentation PRs are always welcome:

- Fix typos, clarify explanations
- Add examples, code snippets
- Expand docs/STATUS.md or CONTEXT.md with clarified terms
- Write tutorials or blog posts (link them in README)

---

## Development Setup

### Prerequisites

- Node.js 18+ (20+ recommended)
- npm 9+
- Git
- Optional: API keys for live provider e2e tests

### Clone and Install

```bash
git clone https://github.com/xioshark/xiocode.git
cd xiocode
npm install --ignore-scripts
```

### Build

```bash
npm run build
```

This compiles TypeScript for all packages and extensions.

### Verify Installation

```bash
npx xio --help
```

Expected output:
```
XioCode - A self-iterating AI coding agent

Usage:
  xio [options]
  xio -p "your prompt here"
  ...
```

---

## Project Structure

```
xiocode/
├── src/cli/                # xio CLI, config parser, extension wiring
├── src/runtime/            # self-owned agent loop, tools, providers, REPL
├── extensions/
│   ├── xio-evolve/         # TrajectoryRecorder + RunStore + Denoiser + ContextInjector
│   └── xio-sandbox/        # WorktreeSandbox + MergeGate
├── docs/
│   ├── STATUS.md           # Delivery snapshot
│   ├── adr/                # Architecture decisions
│   └── archive/            # Historical plans / contracts
├── package.json
├── tsconfig.json
├── test.sh
└── README.md
```

本仓库不依赖 `@earendil-works/pi-*`。扩展通过 `XioExtensionAPI` 注册。

---

## Coding Standards

### TypeScript Rules

1. **Erasable-only syntax** — No `enum`, `namespace`, `import =`, `export =`
   - These require JS emit and break Node's strip-only mode
   - Use `const` enums → plain objects, `namespace` → plain modules

2. **No `any`** — Use `unknown` and narrow with type guards

3. **Prefer `readonly`** — Immutable-first data structures

4. **Explicit return types** — For exported functions

5. **No default exports** — Use named exports for better refactoring

### Naming Conventions

- **Files**: kebab-case (`strategy-learner.ts`)
- **Classes**: PascalCase (`StrategyLearner`)
- **Functions**: camelCase (`extractToolSequence()`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_RETRIES`)
- **Interfaces**: PascalCase, no `I` prefix (`ToolCall`, not `IToolCall`)

### Code Organization

- **File length**: ≤ 300 lines. Split larger files by responsibility.
- **Function length**: ≤ 50 lines. Extract helpers if longer.
- **Nesting depth**: ≤ 3 levels. Use early returns / guard clauses.
- **Parameters**: ≤ 3 positional. Use options object for more.

### Imports

Group and order:

```typescript
// 1. External dependencies
import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';

// 2. Pi-agent packages
import { type AgentContext } from '@earendil-works/pi-agent-core';

// 3. Internal dependencies (same package)
import { type ToolCall, type ToolResult } from './types.js';

// 4. Relative imports
import { RunStore } from './run-store.js';
```

Always use `.js` extension in imports (TypeScript with `--module nodenext`).

---

## Testing Guidelines

### Run Tests

```bash
# All tests (skips e2e without API keys)
./test.sh

# Specific extension
npm run test:unit

# Watch mode
npx vitest watch extensions/xio-evolve/test
```

### Test Structure

Place tests in `test/` subdirectory, mirroring `src/` structure:

```
extensions/xio-evolve/
├── src/
│   ├── strategy-learner.ts
│   └── prompt-evolver.ts
└── test/
    ├── strategy-learner.test.ts
    └── prompt-evolver.test.ts
```

### Test Naming

```typescript
import { describe, it, expect } from 'vitest';

describe('StrategyLearner', () => {
  describe('extractToolSequence()', () => {
    it('should extract tool names in order', () => {
      // ...
    });

    it('should handle empty trajectory', () => {
      // ...
    });

    it('should deduplicate consecutive identical tool calls', () => {
      // ...
    });
  });
});
```

### Coverage Target

- **New code**: 80% coverage minimum
- **Critical paths**: worktree sandbox, merge gate, trajectory recorder
- **UI/CLI code**: Lower priority (harder to test)

Run coverage report:

```bash
npx vitest --coverage
```

### Mocking

Use vitest's built-in mocking:

```typescript
import { vi } from 'vitest';

const mockExecute = vi.fn();
vi.mock('./executor.js', () => ({
  execute: mockExecute,
}));
```

For LLM responses, use fixture files:

```typescript
import { readFileSync } from 'node:fs';

const mockResponse = JSON.parse(
  readFileSync('./test/fixtures/llm-response.json', 'utf-8')
);
```

---

## Commit Messages

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat` — New feature
- `fix` — Bug fix
- `docs` — Documentation only
- `refactor` — Code restructure (no behavior change)
- `test` — Add/update tests
- `chore` — Build, deps, config

### Scope

- `core` — xio wrapper CLI
- `evolve` — xio-evolve extension
- `sandbox` — xio-sandbox extension
- `contracts` — Interop protocols
- `docs` — Documentation

### Examples

```
feat(evolve): implement SpeculativeExecutor for tool prefetching

Adds pattern-based tool call prediction and prefetch caching.
Based on PASTE paper (arxiv.org/html/2603.18897v1).

Reduces task completion time by ~48% on grep→read→edit chains.

Closes #42
```

```
fix(sandbox): PathGuard incorrectly rejects valid symlinks

realpath() was called before path.resolve(), causing false positives
when workspace root itself is a symlink.

Fixes #67
```

```
docs(quickstart): add Docker sandbox setup instructions

Previously only mentioned "optional Docker", now includes full config
example and troubleshooting steps.
```

---

## Pull Request Process

### 1. Before You Start

- Check [ROADMAP.md](./ROADMAP.md) to see if the feature is planned
- Comment on the related issue to claim it
- Discuss design for large changes (open a discussion issue first)

### 2. Create a Branch

```bash
git checkout -b feat/speculative-executor
# or
git checkout -b fix/pathguard-symlink-bug
```

Branch naming: `<type>/<short-description>`

### 3. Make Changes

- Follow [Coding Standards](#coding-standards)
- Add tests for new code
- Update documentation if behavior changes

### 4. Pre-Commit Checks

```bash
# Type check + lint
npm run check

# Tests
./test.sh

# Build (ensure no compilation errors)
npm run build
```

All must pass before pushing.

### 5. Commit and Push

```bash
git add .
git commit -m "feat(evolve): implement SpeculativeExecutor"
git push origin feat/speculative-executor
```

### 6. Open Pull Request

On GitHub, open a PR with:

- **Title**: Same as commit message subject
- **Description**:
  - What does this PR do?
  - Why is it needed?
  - How was it tested?
  - Screenshots/logs (if applicable)
  - Closes #<issue-number>

### 7. Code Review

Maintainers will review within 3-5 days. Expect feedback on:

- Code quality (readability, performance, edge cases)
- Test coverage
- Documentation
- Alignment with project goals

Address feedback, push updates. PR title will auto-update if you amend the commit.

### 8. Merge

Once approved, maintainers will merge. Your contribution will be credited in CHANGELOG.md.

---

## Extension Development

### Creating a New Extension

1. **Create directory structure**:

```bash
mkdir -p extensions/xio-my-extension/src
mkdir -p extensions/xio-my-extension/test
cd extensions/xio-my-extension
```

2. **Initialize package**:

```json
{
  "name": "@xiocode/my-extension",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@earendil-works/pi-agent-core": "^0.4.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^2.0.0"
  }
}
```

3. **Write extension entry point**:

```typescript
// extensions/xio-my-extension/src/index.ts
import type { AgentContext } from '@earendil-works/pi-agent-core';

export function register(ctx: AgentContext): void {
  // Register tools
  ctx.registerTool({
    name: 'my_tool',
    description: 'Does something useful',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string' },
      },
      required: ['input'],
    },
    execute: async (args) => {
      return { result: `Processed: ${args.input}` };
    },
  });

  // Register commands
  ctx.registerCommand('/my-command', {
    description: 'Runs my custom command',
    execute: async () => {
      console.log('Command executed!');
    },
  });

  // Hook into lifecycle events
  ctx.on('turn.start', async () => {
    console.log('Turn starting...');
  });

  ctx.on('tool_call', async (event) => {
    console.log(`Tool called: ${event.tool_name}`);
  });
}
```

4. **Register in xio config**:

```toml
[extensions.my-extension]
enabled = true
path = "./extensions/xio-my-extension"
```

5. **Build and test**:

```bash
npm run build
npx xio  # Your extension should load automatically
```

### Extension Best Practices

- **Don't modify runtime core lightly** — Prefer extension hooks and registration APIs
- **Fail gracefully** — If extension init fails, log error but don't crash agent
- **Document config options** — Add README.md to your extension directory
- **Version carefully** — Breaking changes should bump major version
- **Test in isolation** — Unit tests shouldn't require full agent runtime

---

## Questions?

- **GitHub Discussions**: Ask questions, share ideas
- **GitHub Issues**: Bug reports, feature requests
- **Email maintainers**: For private security disclosures

---

**Thank you for contributing to XioCode!** 🎉
