# Changelog

All notable changes to XioCode will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- Nothing yet

### Changed
- Nothing yet

### Fixed
- Nothing yet

---

## [1.1.0] - 2026-06-04

### Added

- **Stack Trace Truncation**: Automatically truncate error stack traces to save 32–70% tokens
  - Support for Node.js, Python, Rust, Java formats
  - Keeps error message + top 5 frames + origin frame
  - Configurable via `maxStackFrames` option

- **Progressive Disclosure for Large Files**: Generate code outline for files >500 lines
  - Support for TypeScript, JavaScript, Python, Rust, Java
  - Extracts imports, classes, functions, interfaces, enums, types
  - 61–92% token savings (525-line file → ~50-line outline)
  - Fallback to line truncation for unsupported file types

- **Secret Redaction**: Automatically redact sensitive data from trajectory logs
  - API keys: OpenAI, GitHub, Anthropic, AWS, Google Cloud
  - Environment variables: *KEY, *SECRET, *TOKEN, *PASSWORD
  - Sensitive files: .env, .pem, .key, credentials.json
  - Recursive object/array traversal
  - Debug mode for development environments

- **Permission Audit Logging**: Record all permission decisions to JSONL
  - Timestamp, tool name, arguments, decision, matched rule
  - Logged to `~/.xiocode/runs/<run_id>/permissions.jsonl`
  - Async logging (non-blocking)

- **File Diff Tracking**: Track file modifications with diffs
  - SHA-256 hash for change detection
  - Unified diff format (git-compatible)
  - Auto-capture snapshots before Edit/Write

- **Trajectory Visualization**: `/replay` command for execution replay
  - Colored terminal output (user/thinking/tool/result/error)
  - Progress tracking [N/total] + timestamps
  - Configurable playback speed (`--speed=N`)
  - HTML export with dark/light themes
  - CLI: `npx tsx extensions/xio-evolve/cli/replay.ts <trajectory.json>`

### Changed

- ResultDenoiser now supports outline generation for large files
- TrajectoryRecorder now includes permission logging and file diff tracking
- All trajectory events now redact sensitive information before writing

### Performance

- Token savings: 60% in typical sessions (~11,177 → ~4,436 tokens)
- Cost savings: ~$0.10 per session (Claude Opus pricing)
- Test suite: 332 tests passing in 1.4s

### Security

- P0: Permission audit trail for all tool calls
- P0: File change tracking with cryptographic hashes
- P1: Sensitive data redaction in trajectory logs

---

## [0.1.0-alpha] - 2026-06-04

**First public release** — Minimal viable agent with core self-iteration loop.

### Added

#### Core Runtime
- xio wrapper CLI: TOML config → pi-agent settings mapping
- Multi-provider support: OpenAI, Anthropic, DeepSeek (OpenAI-compatible)
- Environment variable setup: `api_key_env` → actual env vars
- Tool registry: read, write, edit, bash, grep, glob (pi-agent built-in)

#### xio-evolve Extension
- **TodoEnforcer**: System prompt injection for forced TODO generation
- **TrajectoryRecorder**: Write `events.jsonl` + `trajectory.json` per run
- **RunStore**: `~/.xiocode/runs/` directory management + indexing
- **StrategyLearner**: Analyze trajectories → extract tool preferences and failure patterns (🔴 untested, awaiting 50+ runs)
- **PromptEvolver**: Generate system prompt addendum from strategy report (🔴 untested)
- **EvalComparator**: Sign test for A/B validation of prompt changes (🔴 untested)
- **ContextInjector**: Auto-inject git status/branch/commits at turn start
- **ResultDenoiser**: Truncate long tool outputs (read: 500 lines, bash: 4000 chars, grep: 20 matches)
- **PrefixCacheAuditor**: Enforce system prompt byte stability for DeepSeek cache
- **ModelRouter**: Classify task complexity → route to simple/complex model (🟡 needs integration testing)
- **ActiveTools**: Auto-enable exploration tools (grep, glob) based on task complexity

#### xio-sandbox Extension
- **PathGuard**: Symlink resolution + workspace containment + sensitive path blocking
- **DockerPool**: Container acquire/release with warm pooling (🟡 idle eviction buggy)
- **PermissionEngine**: deny > allow > mode precedence, pattern matching for tool calls (🟡 regex-only, needs structured patterns)
- **SandboxPolicy**: Contract-aligned policy fields (image, network, memory, timeout)

#### pi-ace-tool (Third-Party)
- Installed as-is: `search_context` tool + `/ace-*` commands

#### Documentation
- README.md: Product overview, competitive analysis, quick start
- QUICKSTART.md: 5-minute guided tutorial
- HARNESS.md: Design philosophy and core principles
- CONTEXT.md: Domain glossary
- CODE-MAP.md: 7 architecture diagrams (mermaid)
- ROADMAP.md: Feature status and priorities
- CONTRIBUTING.md: Contribution guidelines
- docs/IMPLEMENTATION-STATUS.md: Detailed status of HARNESS.md core responsibilities
- docs/BENCHMARKS.md: Performance validation framework
- docs/TS-MIGRATION-PLAN-v2.md: Migration plan from Go v1

#### Contracts
- tool-contract.md: Tool definition/call/result semantics
- run-event-contract.md: Canonical event envelope format
- sandbox-policy-contract.md: Policy fields + error types
- evidence-alignment.md: Run evidence layout + redaction rules

### Known Issues

- **TrajectoryRecorder**: Turn boundary detection incomplete (logs tool calls as separate turns)
- **StrategyLearner**: Untested (blocked on 50+ trajectory accumulation)
- **PromptEvolver**: Untested (depends on StrategyLearner)
- **EvalComparator**: Untested (needs real A/B data)
- **ModelRouter**: Provider routing needs integration testing
- **DockerPool**: Idle eviction timer doesn't reset properly
- **PermissionEngine**: Pattern matching is regex-only (no structured patterns for bash commands)
- **Error messages**: Not consistently actionable (lacks "how to fix" suggestions)
- **No trajectory visualization**: Must inspect via `cat trajectory.json | jq`
- **No evidence redaction**: Secrets may leak into trajectories (security TODO)

### Performance

- **ContextInjector**: Saves ~1 turn per task (no need to query git status)
- **ResultDenoiser**: Reduces tokens by ~30% on large-file tasks
- **PrefixCacheAuditor**: Enables 90% cache hit rate with DeepSeek

### Migration Notes

Migrated from Go+Python (agent-exec-engine v1) to TypeScript (pi-agent v2). See `docs/TS-MIGRATION-PLAN-v2.md` for component mapping.

---

## [0.0.0] - 2026-05-20

**Internal prototype** — Not released publicly.

### Added
- Proof-of-concept xio-evolve: TODO enforcement only
- Basic PathGuard (translated from Go v1)
- TOML config parser

---

## Version Naming Convention

- **Major (X.0.0)**: Breaking changes to config format, contracts, or CLI interface
- **Minor (0.X.0)**: New features, backward-compatible
- **Patch (0.0.X)**: Bug fixes, documentation, internal refactoring

---

## Upcoming in 1.2.0 (Q3 2026)

Planned features (see ROADMAP.md for details):

- **Self-iteration MVP**: Complete /evolve flow with validated StrategyLearner + PromptEvolver
- **Extended language support**: Go, C++, C# tree-sitter grammars for outline generation
- **Smart outline summaries**: LLM-generated functional summaries for 5000+ line files
- **Interactive replay**: Pause/step/jump controls for trajectory visualization
- **SpeculativeExecutor**: 48% task completion speedup (PASTE paper implementation)

---

[Unreleased]: https://github.com/xioshark/xiocode/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/xioshark/xiocode/releases/tag/v1.1.0
[0.1.0-alpha]: https://github.com/xioshark/xiocode/releases/tag/v0.1.0-alpha
[0.0.0]: https://github.com/xioshark/xiocode/tree/prototype
