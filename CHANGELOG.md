# Changelog

What changed in XioCode, written for the people using it. Entries describe what
you can now do differently, not which internal module moved.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) ·
Versioning: [SemVer](https://semver.org/spec/v2.0.0.html) ·
Release cadence: **every 1–2 weeks** while the project is young.

> Entries before 1.1.1 were written for contributors and name internal
> components. They are kept as a record rather than rewritten.

---

## [Unreleased]

## [1.4.0] - 2026-09-26

This release upgrades the embedded process execution engine to `@xioflow/kernel@0.2.0`, bringing single-writer convergence, bulletproof crash recovery, and honest process lifecycle accounting.

### Added
- **Kernel adjudication CLI (`xio kernel adjudicate`).** Users can now adjudicate indeterminate kernel operations directly from the terminal (`xio kernel adjudicate <opId> [--verdict <verdict>] [--domain <path>]`), releasing held resource leases without manual database intervention.

### Changed
- **Upgraded `@xioflow/kernel` to `0.2.0`.**
  - **Eliminated dual truth sources for run status:** Deleted local runner run-status patching; Run and Operation lifecycles are now exclusively converged and audited by the kernel recovery engine.
  - **Graceful turn cancellation:** Runner turn cancellation now routes through the kernel public API `domain.reportRunCancelled(runId, reason)`.
  - **OpId collision prevention:** Extended `runToken` random entropy using `crypto.randomUUID()`.
  - **Hardened error semantics:** Gracefully handles racing `OperationNotActiveError` states (`not_found`, `already_completed`) and visibly propagates `DuplicateOperationError`.

## [1.3.1] - 2026-09-23

This is the first npm release since 1.2.0, so it also carries everything listed under 1.3.0. It is published from CI through npm Trusted Publishing with a provenance attestation.

### Changed
- **The process layer now runs on `@xioflow/kernel` by default.** Supervised commands (bash tool, done contract, search backends, plan dispatch) execute through the embeddable kernel: process intent is recorded before spawn, a stop must be confirmed before leases are released, output is truncated per stream with spill artifacts, and whatever a crashed process left behind is adjudicated on the next launch. Node.js 22.5+ on Linux/macOS takes this path; older runtimes print one line and keep using the built-in supervisor. Set `XIOCODE_PROCESS_KERNEL=0` to choose the built-in supervisor deliberately.

### Fixed
- **The `/model` picker no longer leaves overlapping ghost text.** Long or CJK model names are clipped to the terminal width with an ellipsis instead of wrapping, so the picker stays inside the screen and every row repaints cleanly.
- **A crashed session no longer leaves its commands stuck as "cannot determine".** Recovery mistook the SIGKILLed process for a live one, so the crash was parked as indeterminate, the resource lease stayed held, and the process group was left running. Recovery now recognises that state, reaps the orphaned group, and records the command as failed (requires `@xioflow/kernel` 0.1.5, which this release pins).
- **A model id that already carries its provider prefix is shown once.** Catalogs that return `opencodego/glm-5.1` no longer render as `opencodego/opencodego/glm-5.1` in the picker or the status line.
- **`/model` reports a bad provider endpoint instead of hanging.** Model discovery gives up after 8 seconds and falls back to the configured catalog.
- **The test suite stopped oversubscribing the machine.** Vitest's default worker count (`cpus - 1`) combined with per-test subprocesses was thrashing: the same suite took 976s and timed out git setup instead of 18.6s green. Workers are now capped.

## [1.3.0] - 2026-08-26

### Added
- **Web Console & Settings Panel (`xio web`).** Added a zero-dependency browser-based workbench with real-time SSE trajectory streaming, working tree diff viewer, and a 4-tab Settings modal (Models & Thinking ladder, AGENTS.md hot-editing with rule presets, Extensions & MCP monitoring, and safety boundaries).

### Fixed
- **PreToolUse hooks fail closed.** Timeout, crash, or any non-zero exit blocks the tool instead of letting it run. SessionStart / PostToolUse / Stop still continue after a timeout.
- **Session list/load no longer rewrite a live journal.** Torn WAL tails are ignored in memory; only the session that holds the lease heals the file before the next append.
- **Oversized `read` tells the model what to do.** Files over 8MiB already fail; the error now includes a `Fix:` line so the agent does not retry the whole file.

## [1.2.1] - 2026-08-12

### Security
- **Workspace paths stay inside the project.** `read` / `grep` / `glob` /
  `write` / `edit` reject escapes and refuse to follow workspace symlinks out
  of the tree.
- **Provider keys no longer leak into child processes.** Bash, hooks, MCP, and
  eval children get a scrubbed env by default; known secret values are redacted
  from events and trajectories.
- **Local state is private by default.** Xio-owned dirs/files under `~/.xiocode`
  are created and migrated to `0700` / `0600` without following symlinks.
- **Trust does not inherit across linked Git worktrees.** Trust is bound to the
  canonical path (and optional HEAD identity); product worktree sessions use an
  in-memory grant only.
- **Shell auto-run is allowlist-only.** Unproven shell text asks every time;
  `/bypass` is just an alias for `/permission full` and does not globally skip
  confirms.

### Fixed
- **First-run trust and `/connect` no longer dead-end** before the main UI can
  respond.
- **Cancelled tool processes tear down their process group** (TERM → KILL), and
  bash/hook/search output is bounded while it is collected so floods cannot grow
  unbounded memory.
- README privacy copy now matches real outbound paths (provider, MCP, hooks,
  update check) instead of absolute “nothing leaves” claims.

## [1.2.0] - 2026-08-03

### Added
- **Real cost in dollars.** The usage footer and `xio -p` now show what a session
  actually cost (`tok:12.3k $0.0042`) using a built-in price table for common
  provider models. A model with no known rate shows `~unknown` — never a fake
  `$0`. Add your own rates under `[pricing."<model>"]` in `~/.xiocode/config.toml`
  for private gateways or negotiated pricing.
- **Dangerous commands ask before running.** High-risk shell patterns trigger a
  confirm showing the exact command.
- **`xio doctor`** and **`xio feedback`.**
- First-run guidance when no API key is configured; actionable provider errors.
- Platform support stated up front (macOS/Linux; Windows → WSL).
- Shortcut sheet via `?` / `/help`, and a hint line under the prompt.

### Changed
- Esc / Ctrl+C interaction, slash-menu fuzzy search, markdown table/heading
  polish, install.sh Node bootstrap, native terminal scrollback default, and
  smoother streaming.
- README rewritten around local-first / BYOK; experimental eval/regress/improve
  marked clearly.

### Fixed
- `npm ci` failed outside one private network because lockfile entries pointed at
  an internal npm mirror.

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

## What's next

There is no fixed feature list. What ships next comes from what people using
XioCode report, ranked by "stops me using it" > "makes me distrust it" >
"improves something I already like". If something is in your way, run
`xio feedback` — that is the roadmap.

Current focus and honest gaps: [docs/ROUTE-B-PRODUCT-PLAN.md](./docs/ROUTE-B-PRODUCT-PLAN.md)
· [docs/STATUS.md](./docs/STATUS.md)

---

[Unreleased]: https://github.com/Xio-Shark/xiocode/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/Xio-Shark/xiocode/releases/tag/v1.2.1
[1.2.0]: https://github.com/Xio-Shark/xiocode/releases/tag/v1.2.0
[1.1.0]: https://github.com/Xio-Shark/xiocode/releases/tag/v1.1.0
[0.1.0-alpha]: https://github.com/Xio-Shark/xiocode/releases/tag/v0.1.0-alpha
[0.0.0]: https://github.com/Xio-Shark/xiocode/tree/prototype
