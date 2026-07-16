# XioCode Self-Improve Loop

> **Opt-in outer loop** for modifying XioCode itself: pick a goal (T4) → edit inside a **candidate worktree** → run verifier → **MergeGate ask**.
> **Not** the default daily coding path — interactive `xio` runs **direct-cwd** with **no git/worktree requirement**.
> Serves final-goal item 4 (self-improvable under merge-ask): [GOAL.md](./GOAL.md).
> Product north stars (all paths): **extreme speed** + **model stays on-task** — see GOAL §北星优先级.
> Delivery snapshot: [STATUS.md](./STATUS.md). Updated **2026-07-16** (performance suite **8/8 archived**; eval gate `default-gate.v1.2.0`; RuntimeEvent bus + steer; dirty baseline + real improve agent + MCP/session cleanup + **trusted eval worktree forced independent of interactive direct-cwd**).

## Daily path vs improve path

| | Interactive `xio` | `xio improve` / trusted eval |
|--|-----------------|------------------------------|
| Workspace | Launch **cwd** (any directory) | Git repo required; **candidate worktree** under `~/.xiocode/worktrees/…` |
| Git | **Optional** (`nogit` ok) | **Required** (gradeable tree) |
| MergeGate | **No** (header: `DIRECT / NO MERGEGATE`) | **Yes** — single outer ask |
| Speed focus | Startup, provider TTFT, WAL, TUI | Same perf budget; isolation is for merge safety, not daily friction |

Self-improve is the differentiated flywheel; **speed and alignment** are the default-product bar.

## Flow

1. **T4 schedule** — queue → red-test placeholders → seeds  
   - Entropy-keyed drafts from post-task retrospective load **before** seeds (`~/.xiocode/improve/queue/entropy-*.json`)
   - Production builtin seeds are **prompt-only** (no whole-file `scriptedChange` overwrite)
2. **WorktreeSandbox** — improve/eval edits happen in `~/.xiocode/worktrees/<repoId>/<sessionId>`  
   - **Only on this path** — not required for normal `xio` sessions  
   - `mainRoot` = improve 启动 cwd 的 git toplevel（从当前工作区仓创建，不是换仓）  
   - Dirty main → hard-fail unless `--allow-dirty` / `[worktree] allow_dirty = true`  
   - Create 后捕获 **visible baseline tree**（Git 临时 index，不含 ignored）并物化进候选 worktree；agent 在该 worktree 内运行，**不**再开嵌套 worktree / 内部 MergeGate  
   - **与交互默认分合同**：日常 `xio` 默认 direct-cwd（`[worktree] enabled = false`，无 MergeGate）；`xio improve` / trusted eval **始终**要求 gradeable candidate worktree，不继承交互 direct-cwd 默认
3. **Verifier** — always `npm run check` first; `--check CMD` only appends extras (unknown/missing CLI args fail closed)
4. **Trusted capability gate (opt-in)** — `xio eval compare` runs from the main checkout against the candidate worktree  
   - `prepareCandidateSession` forces `worktree.enabled = true` and creates a worktree under the trial root when missing  
   - Candidate without a reportable worktree → `INFRA_ERROR`（not a capability claim）
   - Frozen manifest `default-gate.v1.2.0`: safety/capability hard FAIL; **required** hard perf axes incl. `provider.overhead` fixture + provider request/first_token; private join never auto-merges
5. **Private joint gate (opt-in)** — `--private-case <id> --capability-gate` requires private `FIXED` **and** trusted `PASS`
6. **MergeGate** — single outer ask only when gates pass; dirty baseline applies agent delta only and preserves main index

## Merge policy (A1)

- Green verifier **does not** merge into the main tree.
- Merge requires explicit user consent via MergeGate (`/merge`, session-end ask, or `xio improve` prompt).
- Rejecting the ask leaves the main tree unchanged.
- `FAIL`, `INFRA_ERROR`, and `PASS_WITH_CONCERNS` from the opt-in capability gate do not trigger a merge ask.
- Capability green never auto-merges.
- Private `FIXED` alone never authorizes merge; with `--private-case`, trusted `PASS` alone does not either.
- External-eval failures may become Goals; external repo patches are never merged into xiocode.

## Private regression joint gate

`xio regress` cases are **not** `ImproveGoal` inputs. Capture/preflight/compare remain separate. When improving:

```bash
xio improve --private-case <id> --capability-gate
# or dogfood defaults in config.toml:
# [improve]
# capability_gate = true
# private_case = "last"   # reads ~/.xiocode/regressions/.last-case
xio improve
```

MergeGate ask may fire only when **both** hold:

1. private before/candidate `FIXED` for `<id>` against the improve worktree, and
2. trusted capability compare `PASS` (not stub / not `PASS_WITH_CONCERNS`)

`--private-case` without `--capability-gate` fails closed (same for config `private_case` without `capability_gate`). Activation UX: failed-turn hint → `/regress` or `xio regress capture --last` (still requires explicit failure statement + verifier) → durable `.last-case` pointer → improve joint gate.

**Honest boundary**: a private case is joint-gate evidence only. There is no case→GoalStore adapter on the default path.

**Prerequisite**: run evidence must be trustworthy (provider/model + numeric usage).

## CLI

```bash
xio improve              # runOnce (uses [improve] defaults when flags omitted)
xio improve --max 3      # runLoop
xio improve --capability-gate  # require trusted before/after PASS
xio improve --private-case <id|last> --capability-gate  # FIXED × PASS joint gate
./bin/xio-improve --max 1
```

## Components

| Component | Role |
|-----------|------|
| `GoalStore` | queue / red_test / seeds (T4); entropy drafts prepend; production seeds prompt-only |
| `Verifier` | always `npm run check` first; CLI `--check` extras append only |
| `SelfImproveRunner` | outer owner: worktree create → agent → verifier → gates → single MergeGate ask |
| Improve agent executor | runs real agent in **existing** candidate worktree (`spawnImproveAgent`); no nested sandbox session |
| `ExternalEvalAdapter` | stub: eval failure → Goal |
| `xio-eval` | trusted local fixtures, external hidden grader, versioned before/after report |
| `MergeGate` | reused from `xio-sandbox` — never bypassed; dirty baseline uses delta-apply (preserve main index) |
| `xio-regress` | private case + compare; joint with capability via `--private-case` |
| Post-task retrospective (`xio-evolve`) | blockers + wash report → next-turn inject + optional ImproveGoal drafts |
| RuntimeEvent → trajectory (`xio-evolve`) | when session exposes bus, `pipeRuntimeEventsToTrajectory` feeds TrajectoryRecorder (stream-json + evolve share one bus); host `tool_result` still runs denoise / context invalidate |
| ResultDenoiser (`xio-evolve`) | optional truncate/outline of tool bodies; **must not wipe** non-empty results |

### tool_result / Denoiser contract

Interactive and improve paths share the same agent-loop → `tool_result` hooks:

| Shape | Example |
|-------|---------|
| Nested (agent-loop) | `{ call: { id, name, args }, result: { content, isError } }` |
| Flat (legacy tests / older emitters) | `{ toolName, toolCallId, content, input }` |

`toToolHookEvent` / `toToolCall` accept **both**. Denoiser runs on the resolved content. If a hook returns empty `content` while the tool body was non-empty, `emitToolResult` **keeps the original** (fail-closed against silent wipe). Trajectory may still record nested `result` for audit; the model and TUI must see non-empty text for successful read/bash.

The trusted gate is opt-in until credentialed real-model series are established. Stub evaluation exercises controller → child → worktree → hidden grader → report, but is always reported with concerns and cannot authorize merge. Candidate package scripts and tests are advisory; they do not define the trusted outcome.

## Post-task retrospective (evolve)

After each **full** agent task (`agent_end`, non-trivial tool use), xio-evolve runs a deterministic post-task pipeline (subagent-style evidence gatherer + wash):

1. **Extract blockers** from trajectory events / failure_reasons → `blockers.log.json` under the run dir
2. **Wash report** → `retrospective-report.json` + `retrospective-report.md` (locations, causes, optimize actions: config vs xio code)
3. **Inject** the report into the **next** `turn_start` so the **primary agent** can optimize XioCode or `~/.xiocode/config.toml`
4. **Enqueue** high/medium actions as entropy-keyed ImproveGoal drafts (`~/.xiocode/improve/queue/entropy-<action_id>.json`) for `xio improve` (loaded before seeds; same key overwrites with fresher evidence + `seen` count; never auto-merge)

Commands: `/retrospect` (show latest markdown), `/retrospect rerun` (rebuild from last run summary).

Config (`[retrospective]`): `enabled`, `skip_trivial`, `min_tool_calls`, `auto_inject`, `enqueue_improve`, `use_llm` (reserved; wash is always deterministic first).

## Model alignment (daily path — not improve-only)

Mechanisms that keep the **primary agent on-task** without forcing git/worktree:

| Mechanism | Role |
|-----------|------|
| **Plan mode** | Denies write/exec/MCP until plan exists; explore still allowed |
| **TodoEnforcer** | System addendum nudging explicit todo tracking |
| **ContextInjector** | Git context at `turn_start` when repo present — **skipped cleanly when nogit** |
| **ResultDenoiser** | Truncate/outline tool bodies without wiping non-empty content |
| **Mid-turn steer** | Soft at boundaries; hard aborts in-flight provider/tools (`!text`) — not HTTP body inject |
| **Compaction G4** | Transactional summary + persisted resume marker — model knows history was compressed |
| **Tool risk G7** | High-risk bash/MCP/write asks once per session (or deny in `-p`) |

Empty tool context after a successful read/bash is a **harness bug** (alignment + speed waste), not user error.

## Dogfood path (G10)

Shortest honest loop for “this failure should make my harness better”:

1. Run interactive agent (`xio` in **any** directory — **no git/worktree required**; opt-in worktree only with `[worktree] enabled = true`). Long sessions use **TUI route B** (append-to-scrollback + callId tool pairing + Ctrl+O full tool output; early-boot input buffer; see STATUS). Mid-turn **steer**: busy Enter → soft (`session.steer`); `!text` → hard (aborts in-flight provider/tools; not mid-stream HTTP inject). On failure, follow nudge → `/regress` or `xio regress capture --last` (explicit failure statement + verifier).
2. Capture writes case + `~/.xiocode/regressions/.last-case`.
3. Optionally set `[improve] capability_gate = true` and `private_case = "last"`.
4. `xio improve` (or flags) **always** edits in a candidate worktree (even when interactive default is direct-cwd) → verifier → joint FIXED × PASS → **MergeGate ask only**.
5. User rejects → main tree unchanged; worktree retained for inspection.

This is **not** auto-capture and **not** auto-merge.

**Evidence prerequisite for dogfood**: tool bodies must reach the model (nested `tool_result` + Denoiser contract above) **and** the TUI transcript model (callId pairing + retained full output). Empty UI / empty tool messages after a successful read, or parallel tools swapping output, are harness bugs — not “empty worktree”.

**Eval vs interactive workspace**: credentialed / trusted eval candidates must leave a gradeable worktree under the trial root. Interactive direct-cwd is a UX default only; it must not disable eval/improve isolation.

## Out of scope

- Requiring git or worktree for interactive `xio` (direct-cwd is default)
- Auto-merge on green (revoked G4 — do not resurrect)
- Auto-capture from telemetry failure (user verdict still required)
- Default StrategyLearner / PromptEvolver / SpeculativeExecutor
- Merging external repository patches into xiocode
- Claiming host-level isolation: worktrees protect the main tree, but `bash` is not an OS sandbox
- Treating private base-red or `FIXED` alone as a capability PASS or automatic improve trigger
- Treating private cases as ImproveGoal inputs
- Treating MergeGate as proof of sandboxing
- Auto-applying retrospective fixes without primary agent / MergeGate
- Silent dirty-main sessions (must opt in with allow-dirty or clean the tree first; allow-dirty materializes the launch visible baseline tree into the worktree)
- Nested worktree / inner MergeGate inside the improve agent (outer `SelfImproveRunner` owns the only merge ask)
- Dropping the default verifier via `--check` alone (extras append; they never replace `npm run check`)
- Treating `~/.xiocode/worktrees/...` path as “wrong repo”: path is always under the XioCode home layout; content is always from the launch repo’s mainRoot
- Letting ResultDenoiser / tool_result hooks overwrite a non-empty tool body with empty content (model + TUI would both look “empty worktree”)
- Letting interactive `[worktree] enabled = false` disable trusted eval / improve candidate worktrees (isolation contracts are separate from the daily direct-cwd UX default)
- Treating soft/hard steer as mid-stream provider HTTP injection (steer applies at boundaries or via hard abort + next user message)

