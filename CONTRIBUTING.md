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
XioCode - A local-first AI coding agent

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
│   ├── xio-sandbox/        # WorktreeSandbox + MergeGate
│   ├── xio-evolve/         # TrajectoryRecorder + RunStore + Denoiser + ContextInjector
│   ├── xio-hygiene/        # AGENTS.md/CLAUDE.md + skills + user hooks + MCP client
│   ├── xio-improve/        # Self-improve outer loop (T4 + verifier + merge-ask)
│   ├── xio-eval/           # Trusted fixtures, hidden graders, capability gate
│   └── xio-regress/        # Private run → local regression case
├── docs/
│   ├── GOAL.md             # Final product goal (north star)
│   ├── STATUS.md           # Delivery snapshot
│   ├── self-improve.md     # Self-modify + merge-ask
│   ├── adr/                # Architecture decisions
│   └── archive/            # Historical plans / contracts
├── package.json
├── tsconfig.json
├── test.sh
└── README.md
```

本仓库不依赖 `@earendil-works/pi-*`。扩展通过 `XioExtensionAPI` 注册。产品终点见 [docs/GOAL.md](./docs/GOAL.md)；近期待办见 [ROADMAP.md](./ROADMAP.md)。

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
- **Classes**: PascalCase (`GoalStore`, `WorktreeSandbox`)
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

// 2. Internal dependencies (same package)
import { type ToolCall, type ToolResult } from './types.js';

// 3. Relative imports
import { RunStore } from './run-store.js';
```

Always use `.js` extension in imports (TypeScript with `--module nodenext`). Do **not** import `@earendil-works/pi-*` (removed; see ADR 0002).

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
extensions/xio-improve/
├── src/
│   ├── goal-store.ts
│   └── verifier.ts
└── test/
    └── self-improve.test.ts
```

Default evolve path tests cover recorder / denoiser / injector — not StrategyLearner / PromptEvolver (off default path; see [docs/GOAL.md](./docs/GOAL.md) §5).

### Test Naming

```typescript
import { describe, it, expect } from 'vitest';

describe('GoalStore', () => {
  describe('next()', () => {
    it('should drain queue before seeds', () => {
      // ...
    });

    it('should handle empty store', () => {
      // ...
    });

    it('should prefer red_test over seed', () => {
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

- `runtime` — `src/runtime`
- `cli` — `src/cli`
- `evolve` — xio-evolve extension
- `improve` — xio-improve extension
- `sandbox` — xio-sandbox extension
- `docs` — Documentation

### Examples

```
feat(improve): add ExternalEvalAdapter stub for SWE-bench failures

Maps eval failure signals to ImproveGoal entries. External patches
are never merged into xiocode (S4 contract).

Closes #42
```

```
fix(sandbox): MergeGate aborts cleanly on conflict

Conflict leaves the worktree in place and reports the conflicting paths
instead of partially applying the merge.

Fixes #67
```

```
docs(goal): add docs/GOAL.md north star and sync active docs
```

---

## Pull Request Process

### 1. Before You Start

- Check [ROADMAP.md](./ROADMAP.md) to see if the feature is planned
- Comment on the related issue to claim it
- Discuss design for large changes (open a discussion issue first)

### 2. Create a Branch

```bash
git checkout -b feat/external-eval-adapter
# or
git checkout -b fix/merge-gate-conflict-report
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
git commit -m "feat(improve): add ExternalEvalAdapter stub"
git push origin feat/external-eval-adapter
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
  "private": true
}
```

3. **Write extension entry point** (register via `XioExtensionAPI` from `src/runtime` — not pi-agent):

```typescript
// extensions/xio-my-extension/src/index.ts
import type { XioExtensionAPI } from "../../../src/runtime/index.ts";

export function register(api: XioExtensionAPI): void {
  api.registerTool({
    name: "my_tool",
    description: "Does something useful",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string" },
      },
      required: ["input"],
    },
    execute: async (_toolCallId, params) => {
      const input = String(params.input ?? "");
      return { content: [{ type: "text", text: `Processed: ${input}` }] };
    },
  });

  api.registerCommand("my-command", {
    description: "Runs my custom command",
    handler: async () => {
      // ...
    },
  });
}
```

4. **Wire the extension** in CLI extension loading (see `src/cli/xio-extension.ts` and existing `extensions/*` for the current pattern). Prefer config toggles under `~/.xiocode/config.toml` when adding on/off switches.

5. **Build and test**:

```bash
npm run check
npm run test:unit
./bin/xio
```

### Extension Best Practices

- **Don't modify runtime core lightly** — Prefer extension hooks and registration APIs
- **Fail gracefully** — If extension init fails, log error but don't crash agent
- **Document config options** — Add README.md to your extension directory
- **Align with [docs/GOAL.md](./docs/GOAL.md)** — especially merge-ask and honest delivery
- **Test in isolation** — Unit tests shouldn't require full agent runtime

---

## Questions?

- **GitHub Discussions**: Ask questions, share ideas
- **GitHub Issues**: Bug reports, feature requests
- **Email maintainers**: For private security disclosures

---

**Thank you for contributing to XioCode!**
