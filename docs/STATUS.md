# XioCode Status

> Single delivery snapshot. Updated **2026-07-22** (v1.1.0; performance **8/8 archived**; **Agent Runtime Event suite 5/5 done**; **07-16 harness design-gaps 6/6 completed**; **Trellis parallel A→B→C→Integrate archived**; **07-21 ultra parallel DAG pipeline integrate_ok**).
> Product endpoint: [GOAL.md](./GOAL.md). Near-term: [ROADMAP.md](../ROADMAP.md).
> Boards: [performance](../.trellis/tasks/07-15-performance-board.md) · [audit](../.trellis/tasks/07-15-performance-audit-2026-07-15.md) · [runtime events](../.trellis/tasks/07-15-agent-runtime-event-board.md).
> Recently completed: [trellis-parallel-task-orchestration](../.trellis/tasks/archive/2026-07/07-16-trellis-parallel-task-orchestration/) (P2, A→B→C→Integrate **archived**) · [agent-harness-design-gaps](../.trellis/tasks/archive/2026-07/07-16-agent-harness-design-gaps/) (P1, **6/6**) · [ultra-parallel-dag-pipeline](../.trellis/tasks/archive/2026-07/07-21-ultra-parallel-dag-pipeline/) (P1, **5/5 archived**).

## Active Trellis (honest — not shipped)

| Tree | Pri | Progress | What it closes |
|------|-----|----------|----------------|
| _(none)_ | | | `07-21-ultra-parallel-dag-pipeline` archived 2026-07-22. |

## Agent harness ↔ tutorial alignment (2026-07-20)

Semantic parity with the local Agent engineering tutorial (not shipped in the public tree) — **not** a file-format / API clone. Closed by `07-16-agent-harness-design-gaps`.

| Tutorial | Status | XioCode shape |
|----------|--------|---------------|
| ch08/09 session fact vs projection | **aligned** | WAL/state `compaction` fact + `compaction_log`; projection via `SessionHistory`; resume rebuilds, no tool replay |
| ch15 turn snapshot / admission / save-point | **aligned** | `TurnSnapshot` + `HarnessController`; busy → `SessionBusyError`; persist → save_point → settle/`waitForIdle` |
| ch03/10 write queue + edit-before-read | **aligned** | `FileWriteQueue` (realpath) + `FileReadSet`; `[tools] require_read_before_edit` (default true) |
| ch07 steer + follow-up | **aligned** | soft/hard steer kept; follow-up drains at natural end; abort clears with `follow_up.discarded`; TUI `>>text` |
| ch12 project trust | **aligned** | `TrustStore` (`~/.xiocode/trust.json`) + `[trust] mode=ask\|trust\|off`; untrusted skips project hooks/skills/MCP |
| ch13 SDK/RPC | **deferred** | stream-json + TUI + `-p` only |
| JSONL parentId session tree | **deferred** | enhance existing WAL; no dual fact source |
| Operations SSH/container | **deferred** | interface shape only; not productized |

Flags for rollback: `[harness] snapshot`, `[tools] require_read_before_edit`, `[trust] mode`.

## Product priorities (north star)

| Priority | Shipped baseline | Honest next |
|----------|------------------|-------------|
| **Extreme speed** | early-boot first_frame P50~42ms; `--version` P50~25ms; Session WAL journal P95 ~4.3ms; TUI projection P95≪25ms; AGENTS/skills `DiscoveryCache`; provider schema cache + stable-prefix; eval hard perf axes (`default-gate.v1.2.0`) | Bench regressions are P0; live TTFT on gateway may INFRA 503 — do not silently relax thresholds |
| **Model on-task** | plan mode; TodoEnforcer; ContextInjector; steer soft/hard + **follow-up**; tool_result integrity; durable compaction facts; turn snapshot/admission; same-path write queue + edit-before-read; project trust gate; callId tool pairing; markdown scrollback + `@` mentions | bus→TUI UI; token-accurate `/context` |
| **Zero-friction workspace** | **Default direct-cwd** — git **optional**, worktree **off** (`DIRECT / NO MERGEGATE` badge); non-git dirs start (`nogit`) — `07-16-nongit-direct-cwd` archived | Do not reintroduce git/worktree as startup gate; project trust must not kill zero-friction cwd |
| **Provable self-improve** (opt-in) | `xio improve` / trusted eval **always** use candidate worktree + MergeGate; **one-key failure capture** on turn-fail / hard steer / `/rollback` (`07-16-failure-capture-hook`) | Corpus under `~/.xiocode/runs/` still thin; capture still needs human verdict + verifier |

## Shipping

- Self-owned TypeScript runtime (`src/runtime`); package version **1.1.0**
- CLI + TOML config (`providers`, `worktree`, extension on/off); `curl | bash` installer + slim npm payload (`files` excludes tests/docs/scripts); **`prepack` runs `npm run check` then payload existence checks**
- **Performance suite (Trellis 07-15) — 8/8 archived** (see board):
  - **Observability (archived)**: trusted fixtures (reducer/coalescer + SessionStore WAL + runs mirror); `xio bench run --all --json` → `~/.xiocode/perf/`. Explore mock labeled; real-provider explore opt-in only.
  - **Fast startup (archived)**: AOT + **early operable boot** (`early-boot.ts` zero-dep chrome → `boot-shell.ts` Ink handoff; `BootInputBuffer` buffers stdin until `prompt_ready`; `first_frame` P50~42ms) + Ink upgrade/input buffer; AGENTS/skills **parallel + `DiscoveryCache`** (30s TTL, cwd/home/config fingerprint); `--version` P50~25ms. Pure Ink-first intentionally deferred (cold import).
  - **TUI throughput (archived)**: tail preview + compact chunks; projection-path paint P95≪25ms. **Not** full Ink host/terminal-write instrumentation.
  - **Session WAL (archived)**: live cursor O(delta) journal hot path via SessionStore; journal P95 ~4.3ms. Gate on `kind=journal` (aggregate `checkpoint.persist` mixes snapshot).
  - **Provider efficiency (archived)**: controls + schema cache + token compaction + stable-prefix contract; Anthropic `cache_control` on last **stable** system block. Live cache/TTFT probe **INFRA 503** on configured gateway (documented — non-blocking).
  - **Workspace perception (archived)**: product tools `query_workspace` / `read_evidence` on main+explore; EvidenceStore `putSnippet`; ref-repo warm P95 ~0.176ms. GitNexus live merge optional when index present.
  - **Adaptive explore (archived)**: live `ExploreOrchestrator` + brief inject + fast-lane skip + wall/straggler + **nonzero product budgets** (`max_tokens=250000`, `max_cost_usd=1`, `max_starts_per_minute=24`; `0`=unlimited; `provider_rate_budget` skip; incomplete coverage in `brief.gaps`). Task: `07-15-adaptive-subagent-orchestration`.
  - **Eval gate (archived)**: multi-axis `xio eval compare` + `default-gate.v1.2.0` (required hard perf axes incl. `provider.overhead` fixture; safety hard-fail; private join never auto-merge). Task: `07-15-performance-capability-eval-gate`.
- Builtin tools: read / write / edit / bash / grep / glob
- **Default workspace: direct-cwd** — run in launch directory; **git not required**; **worktree off by default** (no MergeGate on daily path)
- Outer worktree sandbox + MergeGate (`xio-sandbox`) — **opt-in only** (`[worktree] enabled = true`); used by **`xio improve` / trusted eval** regardless of interactive default; **protects main-tree merge only; not OS isolation**
  - Opt-in worktree: requires git; launch root = cwd 的 git toplevel；物理路径 `~/.xiocode/worktrees/<repoId>/<sessionId>`
  - Create 后 **visible baseline tree**（临时 index + `git add -A`，不含 ignored）物化进 worktree；`baseline_tree` 持久化；session rollback 恢复 baseline
  - Dirty merge：仅应用 baseline→candidate agent delta，保留主树 index；主树漂移 fail closed
- Self-improve outer loop (`xio-improve` / `xio improve`) — T4 + real agent in candidate worktree + verifier (`npm run check` + extras) + single outer merge-ask；builtin seeds prompt-only
- **Post-task retrospective**: each full agent task → blocker log + washed report under run dir; inject next turn for primary agent; high/medium actions enqueue entropy-keyed ImproveGoal drafts (`~/.xiocode/improve/queue/entropy-*.json`, MergeGate only; `/retrospect`)
- **Tool/contract Fix hints**: builtin write/edit/bash/grep/glob errors and done-contract failures append `Fix:` next-step guidance
- **Architecture guards**: vitest locks extensions/runtime ↛ `src/tui` and default evolve/extension assembly not wiring StrategyLearner / PromptEvolver / SpeculativeExecutor
- Trusted local capability baseline (`xio eval`) — versioned reports, 5 dev/holdout families, external hidden graders, preflight/smoke/compare
- **Multi-axis eval gate** (`xio eval compare` + `default-gate.v1.2.0` / `--perf-*` / `--private-case`): safety/capability hard FAIL; **required** hard perf axes (incl. `provider.overhead` fixture + provider request/first_token); private join never auto-merge (`auto_merge_authorized: false`)
- User-confirmed private regression capture (`xio regress`) — versioned local cases, evidence hashes, pinned-base red preflight
- Private before/candidate compare (`xio regress compare`) — `FIXED` / `STILL_RED` / …; **does not authorize MergeGate**
- Opt-in self-improve capability gate (`xio improve --capability-gate`) — only trusted `PASS` can reach MergeGate ask
- Opt-in joint gate (`--private-case` + `--capability-gate`) — private `FIXED` × trusted `PASS` required together
- **Default private flywheel (G10)**: failure signals (turn failed / hard steer / `/rollback`) offer one-key capture when `[regress] offer_on_failure = true` (default); decline is sticky per turn; draft enrichment is best-effort and degrades to manual `/regress` prompts; successful capture writes `~/.xiocode/regressions/.last-case`; `[improve] capability_gate` / `private_case` supply dogfood defaults for bare `xio improve` (CLI flags still override); joint FIXED × PASS still asks only — never auto-merges; **private case ≠ ImproveGoal**
- **Credentialed capability evidence (G9)**: real eval loads `/connect` credentials; `--candidate-mode` / `--model provider/model` / `--repeat N`; selected-provider child env allowlist only; `credentialed-series.v1` under eval root; stub remains harness-only `PASS_WITH_CONCERNS`
- Default evolve path: TrajectoryRecorder, RunStore, ResultDenoiser, ContextInjector, TodoEnforcer — **alignment stack on every session** (ContextInjector no-ops cleanly without git)
- **tool_result payload integrity** (`xio-evolve` + agent-loop):
  - `toToolHookEvent` / `toToolCall` 兼容 agent-loop 嵌套 `{ call, result: { content } }` 与旧扁平 `{ toolName, content, … }`
  - ResultDenoiser 吃真实 content（不再因顶层 `content` 缺失而降噪成空串 → 模型/TUI 全空）
  - `emitToolResult`：**原文非空、hook 返回空 content 时拒绝覆盖**
  - read args 认 `path` 与 `file_path`
  - 回归：nested `read`/`bash` denoise 后非空；空 hook 不能抹掉真实 tool 正文
- **Run evidence integrity**: `session_start` writes provider/model into `metadata.json`; `model_change` updates them; SecretRedactor does not wipe `*Tokens` usage counters in events
- **Dirty main policy**: only when worktree is enabled — dirty main trees **hard-fail** unless `xio --allow-dirty` or `[worktree] allow_dirty = true`。允许后物化启动时 visible baseline tree。默认 main-cwd 模式不拦 dirty / 不要求 git
- **Tool risk permissions (G7)**: risk classes `read|search|write|exec|network|merge`; plan mode denies write/exec/MCP; build interactive asks once per high-risk tool; `-p` denies unless `--allow-high-risk` / `[permissions] allow_high_risk`; `/bypass` still auto-approves with audit notify; `[mcp] unknown_source_fail_closed` skips Claude/Cursor auto-import; `host_isolation: unsupported` in `/status`
- **Regress activation MVP**: `/regress` (session) + `xio regress capture --last` (defaults `failure_type`); auto-preflight; `create --help` is valid help (not INVALID_CASE)
- **Improve joint gate**: `xio improve --private-case <id> --capability-gate` requires private `FIXED` × trusted `PASS` before MergeGate ask; either alone never asks
- **AGENTS.md / CLAUDE.md injection**, **Skills**, **User hooks**, **MCP client** (`xio-hygiene`) — MVP for **target repo** trees; public product tree does **not** ship product-root AGENTS/CLAUDE; **`DiscoveryCache`** dedupes parallel AGENTS/skills discovery per process
- **MCP hardening**: honor `disable` / `disabled` in imported configs; stdio command existence check (ENOENT fails fast, not hang); connect ownership from transport create（timeout 也 close/force-kill）；`listTools` 失败立即 close + 移出 live registry；`closeAll` / `session_end` 有界延迟；会话退出经 `exitCli` 兜底
- **Session delete**: `xio resume --delete <id>` 在删 metadata 前清理注册 worktree、专属 branch、checkpoint refs；身份不匹配 fail closed
- **Permission modes** (`strict` / `auto` / `full`; Shift+Tab or `/permission`), **`xio models`**, Ink TUI core + merge/rollback/bypass + session resume
- **Plan board**: `plan` tool → PRD + implement + `tasks.json` under **`.claude/plan/`** (Claude Code tree; legacy `.xiocode/plan` still readable); TUI todo panel; `plan update`
- **Agent config layout**: target-repo Claude Code paths — `CLAUDE.md` / `.claude/CLAUDE.md` / skills / hooks / MCP; `~/.xiocode` is runtime state only (config, runs, sessions, worktrees, evals, regress, improve)
- **Ink TUI polish**（`07-15-fix-tui-interaction-regressions` + **`07-16-tui-interaction-parity` / `07-16-tui-pi-interaction` archived**）：
  - 分层语义：`▸` thinking / `⚙` tool / `●` answer（tool 开始时折叠进行中 thought）
  - **默认滚动路线 B — append-to-scrollback**（`src/tui/run-ink-session.ts` + `transcript-log.ts`）：
    - `alternateScreen: false`（主 buffer，不占满屏自管视口）
    - 定稿块经 Ink **`<Static>`** 只写一次进终端 scrollback → **触控板/滚轮/搜索由终端负责**
    - live 流式（thinking/assistant + **callId-keyed in-flight tools**）+ header/input/modals sticky 重画
    - 采用「聊天线性 + 原生滚动」产品路线；**不**宣称与 Pi/Claude/Codex 行为全量对齐；**不做** fullscreen 自实现滚轮手感
  - **Canonical transcript projection**：`reduceScrollback` 为 Route B 唯一 tool 语义源
    - 并行同名 tool 按 provider `callId` 配对；缺 id 时用 `synthetic-N`
    - 定稿块保留**完整** `output`；Static 只渲染 8 行 preview
    - **Ctrl+O** 打开 transcript viewer overlay（读保留全文，不改 `<Static>` 历史）
  - **Markdown scrollback**（定稿块）：标题/加粗/列表/围栏代码高亮；live 流式预览可保持纯文本（perf：不在 hot delta 路径渲染）
  - **`@` file mentions**：composer `@` 打开模糊文件选择；选中路径注入模型上下文（尊重 `.gitignore`）
  - **Usage footer**：会话累计 tokens + cost（cost 仍可为 `null`，直至 G8 price table）
  - **`/model` switcher**：slash 选择 provider/model；下一 turn 生效
  - **Startup / resume**：`TuiSessionBridge` 预订阅缓冲，prepareSession 通知不丢不重；resume 渲染 compaction / `completion unknown`
  - **Composer**（`src/tui/composer.ts`）：光标、grapheme 删除、多行/bracketed paste、历史；busy Enter → **steer**（soft）；`!text` hard；`>>text` **follow-up**；composer UI `queue` 仍是草稿缓冲（与 follow-up 队列分离）
  - **Structured confirm**：`ask(question, detail?)` 显式 detail；MergeGate / high-risk 不再靠 last-notice 侧信道
  - **隔离徽章**：header 持久 `DIRECT / NO MERGEGATE` 或 `WORKTREE`
  - 测试 / 可选路线 A：`appendScrollback: false` 时仍可用行级 `sliceTranscriptWindow`（自管视口，供单测；pairing 仍在 `reduceEvent`）
  - select/resume accent；confirm `lines a–b/n`；busy `working…`；`/help` from `collectSlashCommands`
  - 工具结果展示：剥 bash wrapper；与 tool_result 完整性配合
- **Explore subagent UI**（`07-16-ultra-subagent-ui` archived）：explore worker 内部 thinking/assistant/tool 流式进 TUI/stdout，`theme.explore` + 缩进；不污染主 session messages 持久化
- **Perf fixture guard**（`07-16-fix-perf-fixture-tui-import` archived）：`tui.replay_10k` 经 `RunFixtureOptions.tuiReplay` 注入，runtime↛tui 架构守卫恢复
- **Trusted eval isolation**：`prepareCandidateSession` **强制** gradeable candidate worktree，**不继承**交互默认 `[worktree] enabled = false`；缺 worktree → `INFRA_ERROR`
- **Context compaction G4**: one session-history owner; `/compact [focus]`; automatic `max_session_messages` trigger; same-provider continuation summary; complete-turn/tool-pair retention; atomic snapshot publish; persisted resume marker; **durable compaction WAL/state facts** before projection replace (half-batch cuts rejected)
- **Execution/file checkpoint-resume G5**: atomic `xio-session.v2` state; v1 load compatibility; original worktree attach/validation; durable hidden-ref turn checkpoint; interrupted tool calls closed as `completion unknown` without replay; resumed MergeGate rollback checkpoint
- **Session WAL (incremental)**: mid-turn `journal.jsonl` overlay + turn-boundary snapshot rewrite; resume = snapshot + journal; warm save uses live cursor O(delta) via SessionStore (perf task 4 archived); unknown journal ops ignored (forward-compat)
- **Harness turn control (ch15)**: immutable `TurnSnapshot` per provider request; admission (`SessionBusyError` for busy prompt/compaction); save-point then listener settle; `[harness] snapshot` rollback flag
- **Tool write discipline (ch10)**: realpath `FileWriteQueue`; `FileReadSet` + edit/overwrite-before-read; `[tools] require_read_before_edit`
- **Project trust (ch12)**: `~/.xiocode/trust.json`; `[trust] mode`; untrusted → no project hooks/skills/MCP + write/exec gate; zero-friction cwd launch retained
- Provider usage normalization (input/output/cache/reasoning; unknown → `null`)
- Secret redaction in trajectories (env-style secrets redacted; usage counters preserved)
- Harness throughput H1–H5; session/turn rollback G5b
- **Host search backends**: builtin `grep` order `ugrep → rg → grep → node`; `glob` order `ugrep → rg → bfs → find → node` (caps 100/500); first `xio init` / config create recommends optional tools without requiring install
- **Robust edit (H8)**: exact unique replace; optional `replace_all`; one whitespace fuzzy retry; optional unified `patch` via `diff` applyPatch
- **Thinking levels**: `/effort` + Tab 全档 (`off`…`ultra`)；UI 档与 wire 分离
  - DeepSeek：产品 `max`/`ultra` 均映射 wire `reasoning_effort=max`（API 无 ultra 字面量）+ `thinking: { type: "enabled" }` 开关
  - 其他 OpenAI-compat：顶档 `max`/`ultra` → `xhigh`（可被 `[providers.*.thinking_level_map]` 覆盖）
- **Multi-explore**: opt-in `[explore]` registers `explore` tool; read-only parallel workers on `explore.model`
  - `max_concurrency` = absolute ceiling **1–16** (default **16**)
  - Live `ExploreOrchestrator` on product path (fast skip / brief / ownership / wall+straggler) with **nonzero product budgets** (`max_tokens` / `max_cost_usd` / `max_starts_per_minute`; `0`=unlimited; `provider_rate_budget` skip)
  - No recursive explore; plan mode allows explore
  - **Subagent stream UI** shipped (see above); ultra enables explore tool — still does **not** auto-spawn write workers (parallel-plan handoff is human-confirm)
- **Agent Runtime Event suite** (**5/5 done**):
  - RuntimeEvent.v1 bus (`src/runtime/events/`); product sinks: **stream-json stdout** + **evolve trajectory** (Text/TUI UI still callback-based).
  - `xio -p --output-format stream-json` — stdout NDJSON only; diagnostics on stderr (prepareSession E2E).
  - Scripted LLM tape (`xio-agent-tape.v1` + goldens via `src/runtime/providers/scripted/`); turn_end trajectory contract (`xio-evolve` prefers RuntimeEvent bus → `pipeRuntimeEventsToTrajectory` when session exposes bus).
  - Mid-turn **steer** (`SteerMailbox`): soft at tool/provider boundaries; hard aborts in-flight provider/tools (incl. open-tool cancel); TUI busy Enter / `!text` / `>>text` (follow-up) wired; **never** inject into in-flight provider HTTP body.
  - **Follow-up queue**: drains only at natural end (no tool calls + soft empty); abort clears with visible `follow_up.discarded` (hard-steer hops keep queue).
  - Board: [agent-runtime-event-board](../.trellis/tasks/07-15-agent-runtime-event-board.md). Does **not** merge Session WAL with Run evidence storage.
- **Trellis task DAG — A→B→C→Integrate** (archived parent `07-16-trellis-parallel-task-orchestration` + children):
  - **Tree ≠ DAG**：`parent` / `children` 只表达归属；**依赖边是 sibling `depends_on`**（任务目录名列表），与树正交。
  - **权威落点**：`task.json.depends_on` + `isolation`（`"worktree"` \| `"shared"`）；`prd.md` / `implement.md` 双写为投影；`task.py drift` 警告不一致（B 可升 fail-closed）。
  - **Ready set**：每个 `depends_on` 目标为 completed/archived 才 ready；`task.py ready <parent>` 列 ready / blocked + 原因 + isolation；环检测 fail closed。
  - **隔离**：改码并行强制 `isolation=worktree`（独立 cwd/branch）；文档/只读可用 `shared`；**永不**同 cwd 裸多写。
  - **B `dispatch-ready`**：ready-set 波次 spawn、失败不解锁下游、`parallel.auto_confirm` / drift fail-closed。
  - **C 默认 `xio` worker**：`parallel.worker`（fallback channel）、Active task + 规划产物注入、worktree cwd。
  - **Full / L4**：`task.py integrate` merge + verify；冲突 → 串行 fix stub；worktree 子任务父 archive 需 `integrate_ok`。
  - **所有权**：DAG 调度在 **Trellis**；xiocode **不**内嵌 `depends_on` 引擎（最多当 worker）。
- **Ultra parallel DAG pipeline**（parent `07-21-ultra-parallel-dag-pipeline`，**archived 2026-07-22**）：
  - **`parallel-plan.v1` + `task.py plan-import`**：一份 JSON → 批量 create/链边/双写/环 fail-closed；`isolation=worktree` 预建 `.trellis/worktrees/<dir>`（默认 dry-run，`--yes` 物化）。
  - **`write_scope` guard**：无依赖边 sibling 写域相交 → plan-import / dispatch-ready fail-closed（保守近似；可漏报未入库文件）；`parallel.scope_fail_closed`（默认 true）。
  - **Dispatch budget**：`parallel.max_concurrency` 默认 **8**（`0`=不限）；可选 `wall_timeout`；全绿后自动 `integrate` dry-run handoff（`--integrate` 才真 merge）。
  - **xio ultra entry**：ultra + `.trellis` 时引导 `plan action=parallel_draft` → `.claude/plan/parallel-plan.json` + 一条 handoff；无 Trellis/git **显式降级**；**永不**静默 auto-spawn。
  - 写域判定是近似、非精确 glob 相交；token/cost 预算不造假（worker 无可信 usage 通道）。

## Known gaps (honest — do not paper over)

- **Speed regression guard**: Trellis 07-15 suite archived (8/8); any future change that regresses startup/provider/WAL/TUI bench axes is P0 — not optional polish.
- **Harness deferred (by design)**: tutorial ch13 SDK/RPC product shell; JSONL parentId session-tree migration; Operations SSH/container backends — see alignment table above.
- **Alignment observability**: steer + follow-up + tool integrity shipped; no single bench score for "model drift" yet; empty-tool-context bugs remain P0 harness defects.
- **Performance residual**: live bench may omit full resource aggregates until harness emits them on every fixture path.
- **RuntimeEvent follow-ups** (out of suite): bus→SessionUi for Text/TUI; explicit `reportProgress()` if progress is promised.
- **Identity–behavior gap**: north star is speed + alignment + direct-cwd; self-improve flywheel is opt-in and still needs explicit failure + MergeGate (one-key offer lowers friction; does not auto-capture).
- **Host isolation**: default is direct-cwd (not sandboxed); opt-in worktree is merge isolation only; `bash` / MCP remain host-reachable (`host_isolation: unsupported`).
- **Cost / tracing (G8)**: TUI shows usage footer; no versioned price table yet → `estimated_cost_usd` often `null`; product-facing span tracing incomplete.
- **Isolation ladder (G6)**: container / microVM path not productized; docs ladder still the target narrative.
- **TUI residual**: Route A `reduceEvent` still has a separate tool-pairing path for the test renderer; external prompt editor / themes / image paste not shipped (deliberate vs pi community surface).
- **Corpus**: stronger self-iteration claims need a growing private run corpus + regression cases under `~/.xiocode/` (failure offer is the fuel pump; library still thin).

## Not on default path / not shipped

- StrategyLearner, PromptEvolver, old strategy EvalComparator, SpeculativeExecutor, replay UI
- Token-accurate context-source breakdown (`/context`)
- PathGuard / PermissionEngine / Docker (deleted; default is direct-cwd; opt-in worktree for merge safety)
- Mandatory git or worktree for interactive sessions (by design: direct-cwd default)
- Auto-merge on green verifier (revoked; do not resurrect)
- Auto-capture from `run.status=failed` (still requires explicit failure statement + verifier)
- Credentialed public capability claims beyond what a checked-in series artifact proves
- Host-level isolation (`host_isolation: unsupported`)
- Private case → GoalStore / ImproveGoal adapter (cases remain joint-gate evidence only)
- Cross-repo replay
- Full Claude hooks / MCP resources·prompts·OAuth marketplace
- Product-root `AGENTS.md` / `CLAUDE.md` in the public GitHub/npm tree (by design)

## Verify

```bash
npm run check
npm test
npm pack --dry-run   # prepack: typecheck then payload existence
./test.sh
./bin/xio eval preflight --json
./bin/xio eval smoke --candidate-mode stub --json   # harness-only; not a capability claim
# Credentialed (manual): ./bin/xio eval smoke --candidate-mode real --model <provider>/<model> --case local-bug-holdout --repeat 1 --json
# Evidence: ./bin/xio -p "ok" && jq . ~/.xiocode/runs/<latest>/metadata.json
# Dirty WIP in target repo (e.g. bm_bff_web): cd <repo> && xio --allow-dirty
#   → worktree under ~/.xiocode/worktrees/<repoId>/… with HEAD + visible baseline tree (git-native)
# Interactive TUI: append-to-scrollback + markdown/@/usage/model + callId pairing + Ctrl+O + composer steer + early-boot buffer
# Runtime events + steer:
#   npx vitest run src/runtime/events src/runtime/steer.test.ts src/runtime/providers/scripted
# Perf + eval gate smoke:
#   npm run build && ./bin/xio bench run --all --iterations 3 --json
#   npx vitest run src/runtime/perf src/runtime/explore src/runtime/workspace src/runtime/providers src/tui/transcript-log.test.ts
#   npx vitest run extensions/xio-eval/test/gate.test.ts
# Regression (sandbox dirty baseline / improve / MCP / session delete / tool body / TUI):
#   npx vitest run extensions/xio-sandbox/test extensions/xio-improve/test extensions/xio-hygiene/test/mcp.test.ts \
#     src/cli/session-delete.test.ts src/tui/ extensions/xio-evolve/test/index.test.ts src/runtime/agent-loop.test.ts \
#     extensions/xio-eval/test/credentialed-evidence.test.ts
# xio regress create/preflight requires an existing local run and user verifier
# Failure offer: turn failed / hard steer / /rollback → one-key capture (kill-switch [regress] offer_on_failure)
# Session cleanup: xio resume --delete <id>  # removes worktree/branch/checkpoint refs then metadata
# Active Trellis (not yet shipping claims): 07-16-trellis-parallel-* (B/C/gate)
# Harness design-gaps (closed 2026-07-20):
#   npx vitest run src/runtime/harness src/runtime/steer.test.ts src/runtime/file-write-queue.test.ts \
#     src/runtime/project-trust.test.ts src/runtime/context-compaction.test.ts src/runtime/session-store.test.ts
```

### G9 credentialed smoke (manual, 2026-07-12)

- Command: `xio eval smoke --candidate-mode real --model opencode-go/deepseek-v4-flash --case local-bug-holdout --repeat 1 --json`
- Status: `PASS_WITH_CONCERNS` (smoke baseline + pricing unavailable; not a public capability claim)
- `eval_id`: `eval-2026-07-12T12-36-43-563Z-a63ebb4b`
- `series_id`: `f29697b997912c1dcbe97db82b41dddca39241c15528b175f9778820eb926700`
- Usage (nullable cost): input `20051`, output `1515`, cache `19200`, reasoning `703`, `estimated_cost_usd` `null`
- Series path: `~/.xiocode/evals/series/<series_id>/credentialed-series.json` (no keys in artifact)
