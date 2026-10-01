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

Requires `@xioflow/kernel` 0.6.0 (rollback results carry `ignoredFiles`; workspace transactions accept an observation log).

### Changed
- **The web console (`xio web`) was redesigned.**
  - Replies render as markdown: headings, lists, tables, code blocks with a language label, highlighting and a copy button. Model output is never treated as HTML, so a reply that contains `<script>` or a `javascript:` link shows it as text.
  - Tool calls are compact rows — an icon, what the tool did (读取 / 编辑 / 运行 …), its target, how long it took and whether it worked. Details open on click; a failed call opens by itself. Thinking collapses to “思考了 N 秒” once the answer starts, and a line at the bottom says what the agent is doing right now and for how long.
  - Scrolling up while a reply streams keeps your place; a “回到底部” button takes you back.
  - A dropped connection is shown within a second and retried with backoff. If `xio web` was restarted (its link token changes), the page says to open the new link instead of retrying forever. Reopening a session asks the server whether it is still running instead of guessing.
  - 代码差异 lists the changed files with +/− counts and shows coloured, collapsible hunks; untracked files are listed too. A failing `git diff` is reported as an error — it used to look like “no changes”.
  - Settings show every built-in provider with its credential status and suggested models, and all eight thinking levels (the page used to offer seven). Saving Anthropic as the provider writes `kind = "anthropic"` — it used to write `"openai"` — and keeps a custom `base_url` already in the config. The config path is shown from `~`.
  - Light, dark or follow-the-system theme, a shark-fin mark and favicon, keyboard navigation for tabs, native dialogs for permission questions, settings and deleting a session (Esc on a permission question still declines it), and no animation when the system asks for reduced motion.
- **The 轨迹 view has a real time axis, and token usage survives a reload.** Sessions now keep a small `timeline.jsonl` next to their state: when each turn, model call and tool call started and ended, and the tokens each model call used (the prompt itself is not copied, only a hash). The waterfall draws every step at its real start and duration, puts parallel tool calls on separate rows, and folds idle time between turns into a labelled break (“空闲 2 小时 13 分”) so a session that spans a day stays readable. The header shows active time next to the session's span. 用量 now reads token and cache totals from the timeline, so they are still there after a refresh. Sessions from before this change have no timeline: they show steps in order and say so. A step that cannot be matched to the timeline is left untimed rather than placed by guess.
- **The installed package always serves the current console.** `npm run build` bundled the CLI before regenerating the embedded page, so a release could ship the previous version of the page.

- **Interactive keymap conflict resolution and cleanup.**
  - `Ctrl+C`: Semantics unified. While busy, cancels running task. While idle, double-press exits without clearing draft text. Draft clearing is reserved exclusively for `Esc Esc`.
  - `Esc Esc`: Context-clean. Double-pressing with a draft clears it into history; double-pressing on an empty prompt opens the rewind picker.
  - `Tab`: Reserved strictly for completion in slash and `@file` candidate menus. Cycle thinking level is moved exclusively to `/think`.
  - `Ctrl+R`: Standardized as reverse prompt history search matching shell/readline conventions. History block fold/unfold moved to `Alt+Z`.
  - `Ctrl+U`: Reserved strictly for readline line kill-to-cursor. Removed ambiguous half-page scroll in empty draft state (use `Ctrl+D` or `PgUp/PgDn`).
  - `Ctrl+P` & `/`: Unified under single fuzzy-matching slash command menu.
- **A passing verification command is not run again while its result is still true.** Each done-contract command now runs with the kernel recording which files it read. Before the next check, XioCode asks whether that pass still describes the workspace: if nothing changed, the earlier pass stands and the summary says `not re-run`; if a file it read changed, it runs again and the summary names the file; if only other files changed, it also runs again, because a cache can hide a dependency from the read set. For `python` / `pytest` commands the bytecode cache is pointed at an empty directory for the run, which makes "nothing it read has changed" reliable at the cost of recompiling on each run. A failed command is always run again. Not covered: dependencies outside the workspace (a service, the network, environment variables); a command whose result depends on those is still treated as unchanged while the workspace is unchanged. Only on the kernel executor; the built-in supervisor runs every command every time, as before.
- **`parallel_edit` discards fewer finished tasks.** A task used to be thrown away whenever a file it had read was changed by another task, even if the change was nowhere near what it looked at (a repository-wide search "reads" every file). Now, when that happens, the task's reads and searches are re-run on the current workspace; if they all return what the task saw, its edits are applied on top, with no extra model call, and the report says so. If something it saw is different now, the task is still reported as a conflict, and the report names the step. Two tasks that changed the same file conflict as before. What an edit reports back counts as something the task saw, so the list of references that `edit` appends after a symbol changes is now in a stable (sorted) order.

### Fixed
- **A rollback no longer says ignored files are unchanged when nobody checked.** Every rollback ended with "Ignored files (.env, node_modules, build output) were not snapshotted and are unchanged", and with `/confine on` it could add that the kernel vouches for a complete rollback, even when a command had just deleted or rewritten `.env`. The message now says what was checked. With `/confine on`, each checkpoint records the size, timestamps and mode of ignored files (about 0.2 s for 13,000 files), so a rollback either confirms they are unchanged or lists the ones that were added, removed or modified and stops short of calling itself complete. With confinement off, it says the ignored files were neither restored nor checked.
- **A command that XioCode stops for printing too much now says so on its first line.** When a command's output passed the 16 MiB cap, XioCode stopped it, but the note explaining that sat at the end of the result, where the length cap on tool results cut it off. The model saw `exit_code=1` and a partial output, as if the command had failed by itself. The first line now reads `exit_code=1 (stopped by XioCode: its output exceeded the hard cap, so the command did not run to completion)`.
- **After a crash, a resumed session no longer says a still-running command had finished.** If the command was still alive when XioCode came back and recovery stopped it, the restored tool result said "the process finished before the interruption". It now says recovery stopped it and that it did not finish. With `XIOCODE_PROCESS_KERNEL=0` the result claimed the command "never started", which the kernel cannot know in that mode; it now says there is no record and the command may have started.
- **Two tool calls in one turn no longer break Anthropic-style providers that are strict about message order.** Each tool result went out as its own user message. DeepSeek's Anthropic-compatible endpoint rejects that with HTTP 400 ("`tool_use` ids were found without `tool_result` blocks immediately after"), so `parallel_edit` workers on such a provider failed on their first parallel search. The results of one turn now travel in a single message.
- **The line REPL (no TTY) keeps reading after an approval prompt.** Answering a `[y/N]` prompt left stdin paused, so the REPL ignored everything typed afterwards and the process ended with exit code 13 once the turn was over.
- **A rollback no longer deletes a file that was ignored when the checkpoint was taken.** If `.gitignore` lost a line during the turn, a file it used to cover (for example `.env`) was treated as a new file and removed.

## [1.6.0] - 2026-09-30

Requires `@xioflow/kernel` 0.5.1.

### Added
- **Rewind to an earlier turn: press Esc twice on an empty prompt (or `/rewind`).** Pick a turn, then restore its files and the conversation, only the conversation, or only the files. Files come back from the snapshot the kernel took when that turn started and are verified by fingerprint; the conversation is cut back to just before that turn and its prompt is put back in the input so you can edit and resend it. Rewind points survive a restart. A point says plainly what it can no longer restore: files once its snapshot has aged out (the last 20 turns keep one), the conversation once it has been compacted. In worktree mode only the conversation can be rewound.
- **`/confine on`: keep commands inside the workspace, and get rollbacks the kernel can vouch for.** With write confinement on (`sandbox-exec` on macOS, `bubblewrap` or `srt` on Linux), commands can only write inside the workspace and only start from inside it. A rollback then says when every command since the checkpoint ran confined, meaning nothing outside the workspace needs undoing. It is off by default because tools that write to caches or `/tmp` fail under it; such a failure now says that confinement is the likely cause. `XIOCODE_KERNEL_CONFINE=1` turns it on at startup, and `/kernel` shows whether it is on.
- **Parallel edits: the agent can hand independent changes to 2–4 worker agents that edit the repository at the same time (`parallel_edit`).** Each worker edits its own fork. A worker's changes are applied as soon as it finishes, unless a file it read or wrote was changed in the meantime, by a worker that finished first or by someone editing the workspace directly. Such a change is not applied; the agent is told which file conflicted and with whom, so it can redo that part. Workers can only read and edit files, not run commands.

### Changed
- **Commands run under the kernel's native process-tree holder where it ships** (Linux x64/arm64, macOS arm64/x64). A command that detaches (`setsid`, double fork) is now stopped with the rest of its tree instead of being reported as a leftover, and if XioCode itself dies the helper stops the tree. `/kernel` shows which driver is in use and why; `XIOCODE_KERNEL_DRIVER=node` selects the previous one, `=reaper` insists on the native one and fails loudly where it is missing.

### Fixed
- **Resuming after a crash no longer calls a command "finished" when its exit was never seen.** If a command ended while XioCode was down, the resumed tool result now says its outcome is unknown and asks to check its effects before running it again.

## [1.5.0] - 2026-09-29

Requires `@xioflow/kernel` 0.4.0.

### Added
- **`/rollback` in direct mode runs on kernel snapshots and tells you what it could not undo.** The session baseline and each turn's checkpoint are kernel snapshots taken through a private index, so your staged changes and HEAD are never touched. After a rollback XioCode says whether the kernel verified the result, lists paths it could not restore, reminds you that ignored files (`.env`, `node_modules`, build output) were never snapshotted, and warns when a command ran since the checkpoint, because such a command may have written outside the workspace.
- **A crash is recovered and reported at the next start, not at the first command.** Opening a session adjudicates whatever the previous launch of that session left running and prints what happened to each operation. Crashed sessions of other workspaces are swept in the background too, so their leftovers do not wait for that session to be resumed.
- **`/kernel` inside a session and `xio kernel status` outside one.** Both list operations the kernel could not confirm stopped, each with the exact command that resolves it (`/kernel adjudicate <id>` while the session runs, `xio kernel adjudicate <id> --domain <path>` after it exits).
- **Resuming a crashed session says what an interrupted command actually did.** Instead of "completion unknown", the tool result now reports whether the command never started, finished (with its exit code and the tail of its output) or is still unconfirmed.
- **Approvals and denials are recorded.** Every permission decision (who decided, which gate, once or for the session) is written to the session's kernel journal next to the command it authorized. Commands and paths are stored as fingerprints, never as text.

### Added (web console)
- **The web console runs the agent.** `xio web` used to store your message and stay on "Thinking…" forever. It now runs the turn with the same startup as the CLI, streams text and tool calls into the transcript, and asks permission questions in a dialog (declining is the default button).
- **The web console only answers the link it prints.** `xio web` prints a URL with a one-time access token; the browser trades it for a same-site cookie. Other web pages can no longer read your sessions, change your settings or API key, or delete sessions (it previously answered any site with `Access-Control-Allow-Origin: *`), and requests with a foreign `Host` are refused.
- **Web console dark mode, narrow screens and keyboard use.** It follows the system theme, the session list becomes a drawer on phones, every control is a real button with a label, and it no longer loads fonts from Google.

### Changed
- **Commands that write to the workspace take turns.** Commands outside the read-only allowlist queue behind each other instead of running at the same time, and a command that had to wait says which one it waited for. A command stuck behind an operation the kernel could not confirm stopped is refused with instructions instead of waiting forever.
- **MCP stdio servers run under the kernel.** Their stderr is bounded and spilled, their stop is confirmed, and a crash leaves nothing running. `XIOCODE_PROCESS_KERNEL=0` keeps the previous transport.
- **`XIOCODE_PROCESS_KERNEL=0` only switches how commands are executed.** Rollback, recovery and the journal no longer depend on it.
- **Node.js 22.13 or newer is required**, as `engines` already said; `xio doctor` and `install.sh` asked for 20.

### Fixed
- **Web console showed made-up numbers and wrong descriptions.** The 94.2% cache hit rate was hard-coded, new sessions claimed `claude-3-7-sonnet`, the permission cards described behavior XioCode does not have (strict asking instead of refusing, full auto-approving shell, a "Docker sandbox"), and the extensions page listed invented features. Usage now shows only what the provider reported; the permission control switches the live session's mode instead of silently rewriting `allow_high_risk`.
- **A single Ctrl+C in the TUI quit and threw away your draft.** Ctrl+C now cancels a running turn, otherwise clears the draft, and only exits on a second press from an empty prompt, as the shortcuts sheet already said.
- **Typing `?` in the TUI opened the shortcuts sheet instead of inserting it**, so "why?" became "why". The sheet opens only from an empty prompt; this also removes the garbled text left when it opened on top of the command menu.
- **Permission questions no longer ask "allow bash for this session?" before showing a command.** Read-only allowlisted commands run without asking; every other command is shown and confirmed on its own. Tools without command text (MCP) show the call's arguments and offer "this call" or "this session".
- **Esc closes the slash-command menu** (the draft stays) instead of doing nothing and clearing the draft on a quick second press.
- **The TUI header shrinks to one line once the conversation starts** and no longer repeats the path the footer already shows.
- **Direct-mode `/rollback turn` staged files and skipped non-ASCII paths.** It restored files with `git checkout <tree> -- <file>`, which also writes your index, and parsed git output without `-z`, so a file like `报告.md` was silently left in place.
- **Every turn was recorded as one never-ending run.** 1.4.0's notes said turn cancellation went through the kernel; the code never ended a run at all. Each prompt is now its own kernel run and ends as succeeded, failed (including a failed done contract, whose verdict is recorded) or cancelled.
- **A command's working directory decided which kernel domain it used**, so a command in a subdirectory closed the session's domain and opened a new one.

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
