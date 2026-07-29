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

### Added
- **Real cost in dollars.** The usage footer and `xio -p` now show what a session
  actually cost (`tok:12.3k $0.0042`) using a built-in price table for common
  provider models. A model with no known rate shows `~unknown` — never a fake
  `$0`. Add your own rates under `[pricing."<model>"]` in `~/.xiocode/config.toml`
  for private gateways or negotiated pricing.
- **Dangerous commands ask before running.** `rm -rf`, `curl … | sh`,
  `git push --force`, `git reset --hard`, raw disk writes and reads of secret
  files now trigger a confirm showing the exact command — every time, even after
  you have approved the `bash` tool for the session. `full` permission mode and
  `/bypass` still auto-approve, but announce the match.
- **`xio doctor`.** One command that checks Node version, config, provider keys
  and connectivity, and prints a paste-ready report with no secrets in it. Node
  version is checked first, since that is the most common install failure.
- **`xio feedback`.** Opens the right issue form from the terminal. XioCode still
  ships no telemetry — this command sends nothing, it just removes the friction
  from telling us something broke.
- **First run no longer dead-ends.** Starting `xio` with no API key configured
  now opens a working session with guidance to `/connect` and a suggested first
  task, instead of failing before you type anything.
- **Actionable provider errors.** Auth failures, rate limits, empty balance,
  missing models, network problems and context overflow each come with the next
  step to take (`/connect`, `xio models`, `/compact`, …) instead of a bare
  status code.
- **Platform support is stated up front.** macOS and Linux are supported;
  Windows is untested and points at WSL. Shown in the README and in
  `xio doctor`.
- Issue templates for bug reports (which ask for `xio doctor` output) and
  feature requests.
- **A key map you can actually find.** Pressing `?` on an empty prompt — or
  running `/help` — opens a scrollable shortcut sheet grouped by what you are
  doing: writing a prompt, steering a running task, reading tool output, running
  the session. The footer had advertised `?` for a while without it doing
  anything; it works now, and it is the one place the `!text` / `>>text` steer
  prefixes and the `Ctrl+O` output viewer are written down.
- **A hint line under the prompt.** While a task runs it shows how to cancel and
  how to steer; when a keystroke is waiting on a second press it says so.

### Changed
- **`Esc` cancels the running task** and keeps whatever you had typed. On an idle
  prompt, `Esc` twice in a row clears the draft — and the cleared text stays
  recallable with `↑`.
- **`Ctrl+C` asks before it ends the session.** It still cancels a running task
  on the first press. When idle it clears a half-typed draft, and only exits
  after a second `Ctrl+C` on an already-empty prompt, so one stray keystroke no
  longer drops you out of a session.
- **The slash menu searches like the file picker.** `/pact` now finds
  `/compact` and `/rlb` finds `/rollback`, ranked prefix first, instead of only
  matching what a command starts with.
- **Tables in answers line up.** Markdown tables are padded to even columns
  before they hit the screen — measured by what the terminal actually shows, so
  CJK text and inline `code` or **bold** stay aligned. The `|` and `---` are
  kept, so a table you copy out of the transcript is still valid markdown, and
  anything too wide to pad is left exactly as the model wrote it.
- **Heading depth is visible again.** `#` and `######` used to render
  identically; the top two levels now carry the accent colour and deeper ones
  are bold only, so a long answer keeps its outline.
- **`install.sh` handles Node itself.** It detects a too-old or missing Node and
  prints the one-line install command for your platform; `XIO_INSTALL_NODE=1`
  installs Node 22 via fnm for you.
- **The terminal owns scrolling again.** Interactive sessions now append
  finished output to your terminal's native scrollback by default, so your
  mouse wheel, scrollbar and terminal search all work normally, and long
  sessions no longer get slower to redraw. The old full-screen viewport is
  still available with `XIO_TUI_FULLSCREEN=1`.
- **Smoother streaming.** The live region is capped to a tail window, so long
  thinking streams no longer cause flicker or stutter.
- README rewritten around what XioCode does for you: crash-proof long sessions,
  local-first and bring-your-own-key, and never auto-merging your code.
  `xio eval` / `xio regress` / `xio improve` are now marked experimental and are
  not part of the supported surface.

### Fixed
- `npm ci` failed for anyone outside one private network: nine lockfile entries
  pointed at an internal npm mirror. They now resolve from the public registry.

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

[Unreleased]: https://github.com/xioshark/xiocode/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/xioshark/xiocode/releases/tag/v1.1.0
[0.1.0-alpha]: https://github.com/xioshark/xiocode/releases/tag/v0.1.0-alpha
[0.0.0]: https://github.com/xioshark/xiocode/tree/prototype
