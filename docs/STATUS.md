# XioCode Status

> Single delivery snapshot. Updated **2026-07-15** (v1.1.0; dirty baseline + improve agent + MCP/session cleanup + prepack typecheck + TUI Route B + **performance suite frameworks in-tree, 0/8 archive-ready** after honest re-audit).
> Product endpoint: [GOAL.md](./GOAL.md). Near-term: [ROADMAP.md](../ROADMAP.md).
> Boards: [performance](../.trellis/tasks/07-15-performance-board.md) · [audit](../.trellis/tasks/07-15-performance-audit-2026-07-15.md) · [runtime events](../.trellis/tasks/07-15-agent-runtime-event-board.md).

## Shipping

- Self-owned TypeScript runtime (`src/runtime`); package version **1.1.0**
- CLI + TOML config (`providers`, `worktree`, extension on/off); `curl | bash` installer + slim npm payload (`files` excludes tests/docs/scripts); **`prepack` runs `npm run check` then payload existence checks**
- **Performance suite (Trellis 07-15) — frameworks landed, not archive-ready** (see board; do not claim 8/8 complete):
  - **Observability (~70%)**: versioned spans (`xio-perf-span.v1`) + `xio bench run --all --json` → `~/.xiocode/perf/`; low overhead. **Not trusted evidence yet** — several fixtures are empty-loop / mock paths.
  - **Fast startup (~72%)**: thin `src/cli/entry.ts` + esbuild AOT (`dist/`); warm `--version` P50 ≤30ms on reference machine. Interactive Ink boot shell + parallel AGENTS/skills init still open.
  - **TUI throughput (~60%)**: 16ms delta coalescer + chunked live buffers; 10K-delta correctness. Real paint/throughput evidence and join hotspots remain.
  - **Session WAL (~55%)**: append-only journal mid-turn (`xio-session-wal.v1`); snapshot at turn boundary. Write bytes are O(delta); save hot path still reloads/rebuilds history-sized work.
  - **Provider efficiency (~85%)**: `max_tokens` / `tool_choice` wire, tool-schema cache, Anthropic `cache_control`, token-aware compaction. Closest to done; real cache-hit/TTFT/cost evidence residual.
  - **Workspace perception (~45%)**: `WorkspaceMap` + EvidenceStore library + non-blocking warm + GitNexus degrade. **Not product-wired** (no agent tools); evidence correctness gaps.
  - **Adaptive explore (~40%)**: lane/role/capsule/brief pure policy + unit simulation. Real explore path does not yet run adaptive dispatch / brief inject.
  - **Eval gate (~58%)**: multi-axis `xio eval compare` shell + `default-gate.v1` (safety hard-fail; private join never auto-merge). Hard perf/awareness axes incomplete; depends on trusted fixtures + perception/adaptive product paths.
- Builtin tools: read / write / edit / bash / grep / glob
- Outer worktree sandbox + MergeGate (`xio-sandbox`) — **opt-in** (`[worktree] enabled = true`); **protects main-tree merge only; not OS isolation**
  - **Default**: run in the launch directory (cwd); git is **optional** — no worktree, no forced repo
  - Opt-in worktree: launch root = cwd 的 git toplevel；物理路径 `~/.xiocode/worktrees/<repoId>/<sessionId>`
  - Create 后 **visible baseline tree**（临时 index + `git add -A`，不含 ignored）物化进 worktree；`baseline_tree` 持久化；session rollback 恢复 baseline
  - Dirty merge：仅应用 baseline→candidate agent delta，保留主树 index；主树漂移 fail closed
- Self-improve outer loop (`xio-improve` / `xio improve`) — T4 + real agent in candidate worktree + verifier (`npm run check` + extras) + single outer merge-ask；builtin seeds prompt-only
- **Post-task retrospective**: each full agent task → blocker log + washed report under run dir; inject next turn for primary agent; high/medium actions enqueue entropy-keyed ImproveGoal drafts (`~/.xiocode/improve/queue/entropy-*.json`, MergeGate only; `/retrospect`)
- **Tool/contract Fix hints**: builtin write/edit/bash/grep/glob errors and done-contract failures append `Fix:` next-step guidance
- **Architecture guards**: vitest locks extensions/runtime ↛ `src/tui` and default evolve/extension assembly not wiring StrategyLearner / PromptEvolver / SpeculativeExecutor
- Trusted local capability baseline (`xio eval`) — versioned reports, 5 dev/holdout families, external hidden graders, preflight/smoke/compare
- **Multi-axis eval gate shell** (`xio eval compare` + optional manifest / `--perf-*` / `--private-case`): safety/capability hard FAIL and private join never auto-merge (`auto_merge_authorized: false`). Hard performance budgets and awareness metrics are **not** fully enforced yet (see performance suite residual)
- User-confirmed private regression capture (`xio regress`) — versioned local cases, evidence hashes, pinned-base red preflight
- Private before/candidate compare (`xio regress compare`) — `FIXED` / `STILL_RED` / …; **does not authorize MergeGate**
- Opt-in self-improve capability gate (`xio improve --capability-gate`) — only trusted `PASS` can reach MergeGate ask
- Opt-in joint gate (`--private-case` + `--capability-gate`) — private `FIXED` × trusted `PASS` required together
- **Default private flywheel (G10)**: failed turns nudge `/regress` / `xio regress capture --last` (with run id when known); successful capture writes `~/.xiocode/regressions/.last-case`; `[improve] capability_gate` / `private_case` supply dogfood defaults for bare `xio improve` (CLI flags still override); joint FIXED × PASS still asks only — never auto-merges; **private case ≠ ImproveGoal**
- **Credentialed capability evidence (G9)**: real eval loads `/connect` credentials; `--candidate-mode` / `--model provider/model` / `--repeat N`; selected-provider child env allowlist only; `credentialed-series.v1` under eval root; stub remains harness-only `PASS_WITH_CONCERNS`
- Default evolve path: TrajectoryRecorder, RunStore, ResultDenoiser, ContextInjector, TodoEnforcer
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
- **AGENTS.md / CLAUDE.md injection**, **Skills**, **User hooks**, **MCP client** (`xio-hygiene`) — MVP for **target repo** trees; public product tree does **not** ship product-root AGENTS/CLAUDE
- **MCP hardening**: honor `disable` / `disabled` in imported configs; stdio command existence check (ENOENT fails fast, not hang); connect ownership from transport create（timeout 也 close/force-kill）；`listTools` 失败立即 close + 移出 live registry；`closeAll` / `session_end` 有界延迟；会话退出经 `exitCli` 兜底
- **Session delete**: `xio resume --delete <id>` 在删 metadata 前清理注册 worktree、专属 branch、checkpoint refs；身份不匹配 fail closed
- **Permission modes** (`strict` / `auto` / `full`; Shift+Tab or `/permission`), **`xio models`**, Ink TUI core + merge/rollback/bypass + session resume
- **Plan board**: `plan` tool → PRD + implement + `tasks.json` under **`.claude/plan/`** (Claude Code tree; legacy `.xiocode/plan` still readable); TUI todo panel; `plan update`
- **Agent config layout**: target-repo Claude Code paths — `CLAUDE.md` / `.claude/CLAUDE.md` / skills / hooks / MCP; `~/.xiocode` is runtime state only (config, runs, sessions, worktrees, evals, regress, improve)
- **Ink TUI polish**（`.trellis/tasks/07-15-fix-tui-interaction-regressions` 收尾）：
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
  - **Startup / resume**：`TuiSessionBridge` 预订阅缓冲，prepareSession 通知不丢不重；resume 渲染 compaction / `completion unknown`
  - **Composer**（`src/tui/composer.ts`）：光标、grapheme 删除、多行/bracketed paste、历史；busy Enter → **queue**（steer 暂不可用时显式提示，禁止 silent no-op）
  - **Structured confirm**：`ask(question, detail?)` 显式 detail；MergeGate / high-risk 不再靠 last-notice 侧信道
  - **隔离徽章**：header 持久 `DIRECT / NO MERGEGATE` 或 `WORKTREE`
  - 测试 / 可选路线 A：`appendScrollback: false` 时仍可用行级 `sliceTranscriptWindow`（自管视口，供单测；pairing 仍在 `reduceEvent`）
  - select/resume accent；confirm `lines a–b/n`；busy `working…`；`/help` from `collectSlashCommands`
  - 工具结果展示：剥 bash wrapper；与 tool_result 完整性配合
- **Trusted eval isolation**：`prepareCandidateSession` **强制** gradeable candidate worktree，**不继承**交互默认 `[worktree] enabled = false`；缺 worktree → `INFRA_ERROR`
- **Context compaction G4**: one session-history owner; `/compact [focus]`; automatic `max_session_messages` trigger; same-provider continuation summary; complete-turn/tool-pair retention; atomic snapshot publish; persisted resume marker
- **Execution/file checkpoint-resume G5**: atomic `xio-session.v2` state; v1 load compatibility; original worktree attach/validation; durable hidden-ref turn checkpoint; interrupted tool calls closed as `completion unknown` without replay; resumed MergeGate rollback checkpoint
- **Session WAL (incremental, partial)**: mid-turn `journal.jsonl` overlay + turn-boundary snapshot rewrite; resume = snapshot + journal. Durability path exists; history-sized reload/compare on save still open (not a full O(delta) hot-path claim)
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
  - Adaptive policy modules exist (lanes / roles / capsule / WorkspaceBrief); **live explore path still incomplete** — do not treat deep-vs-fast awareness as product-proven
  - No recursive explore; plan mode allows explore
- **Agent Runtime Event suite** (planning, 0/5): turn_end trajectory fix → RuntimeEvent.v1 → scripted tape → stream-json → mid-turn steering. Board: [agent-runtime-event-board](../.trellis/tasks/07-15-agent-runtime-event-board.md). Does **not** merge Session WAL with Run evidence storage.

## Known gaps (honest — do not paper over)

- **Performance suite trust**: none of the 8 Trellis perf tasks are archive-ready; fixtures/product wiring must land before hard perf gates or “speed win” claims. Source of truth: performance board + audit under `.trellis/tasks/`.
- **Identity–behavior gap**: north-star wiring is present (evidence → dirty-main → risk → capture → joint gate → config defaults); daily dogfood still requires the operator to confirm failure + verifier and approve MergeGate.
- **Host isolation**: worktree is merge isolation only; `bash` / MCP remain host-reachable (`host_isolation: unsupported`).
- **Cost / tracing (G8)**: no versioned price table yet; `estimated_cost_usd` stays `null` without it; product-facing span tracing incomplete (bench path is local/framework).
- **Isolation ladder (G6)**: container / microVM path not productized; docs ladder still the target narrative.
- **TUI residual**: busy-turn **steer** not provider-safe yet (queue only); Route A `reduceEvent` still has a separate tool-pairing path for the test renderer; external prompt editor not shipped.
- **Trajectory `turn_end` contract**: recorder expects turn index / message / toolResults; agent loop still misaligned (first child of runtime-event suite).
- **Corpus**: stronger self-iteration claims need a growing private run corpus under `~/.xiocode/runs/`.

## Not on default path / not shipped

- StrategyLearner, PromptEvolver, old strategy EvalComparator, SpeculativeExecutor, replay UI
- Token-accurate context-source breakdown (`/context`)
- PathGuard / PermissionEngine / Docker (deleted; worktree model instead)
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
# Interactive TUI: append-to-scrollback + callId pairing + Ctrl+O full output + composer queue
# Perf suite smoke:
#   npm run build && ./bin/xio bench run --all --iterations 3 --json
#   npx vitest run src/runtime/perf src/runtime/explore src/runtime/workspace src/runtime/providers src/tui/transcript-log.test.ts
#   npx vitest run extensions/xio-eval/test/gate.test.ts
# Regression (sandbox dirty baseline / improve / MCP / session delete / tool body / TUI):
#   npx vitest run extensions/xio-sandbox/test extensions/xio-improve/test extensions/xio-hygiene/test/mcp.test.ts \
#     src/cli/session-delete.test.ts src/tui/ extensions/xio-evolve/test/index.test.ts src/runtime/agent-loop.test.ts \
#     extensions/xio-eval/test/credentialed-evidence.test.ts
# xio regress create/preflight requires an existing local run and user verifier
# Session cleanup: xio resume --delete <id>  # removes worktree/branch/checkpoint refs then metadata
```

### G9 credentialed smoke (manual, 2026-07-12)

- Command: `xio eval smoke --candidate-mode real --model opencode-go/deepseek-v4-flash --case local-bug-holdout --repeat 1 --json`
- Status: `PASS_WITH_CONCERNS` (smoke baseline + pricing unavailable; not a public capability claim)
- `eval_id`: `eval-2026-07-12T12-36-43-563Z-a63ebb4b`
- `series_id`: `f29697b997912c1dcbe97db82b41dddca39241c15528b175f9778820eb926700`
- Usage (nullable cost): input `20051`, output `1515`, cache `19200`, reasoning `703`, `estimated_cost_usd` `null`
- Series path: `~/.xiocode/evals/series/<series_id>/credentialed-series.json` (no keys in artifact)
