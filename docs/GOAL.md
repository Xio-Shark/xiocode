# XioCode 最终目标

> 产品终点的单一真相源。交付快照见 [STATUS.md](./STATUS.md)；近期待办见 [ROADMAP.md](../ROADMAP.md)。

**更新日期**：2026-07-16

---

## 一句话

把 XioCode 做成**每个人专属的本地 harness**：**启动快、调模型快、跑起来快**，且**模型少跑偏**；用你自己的失败史持续改进 agent，证据留在本地，合入权始终在你手里。它是可观测、可回滚、可自改进的编码 agent 闭环，不是又一个聊天式 coding CLI，也不是大家共用的通用 agent。

---

## 北星优先级（2026-07 起）

日常默认路径按下列顺序取舍；**已交付能力不回退**，但新功能与优化须先过这一排序：

| 优先级 | 目标 | 产品含义 |
|--------|------|----------|
| **P0** | **极致的快** | 冷启动 / `--version` / first frame 可输入；provider 首 token 与请求开销；Session WAL、TUI 投影、discovery 缓存、schema 缓存、compaction 与并行工具调度——凡增延迟的路径须可度量、可回归 |
| **P0** | **模型不跑偏** | 任务边界清晰（plan / todo / steer / 风险门禁 / 工具结果完整进上下文）；用户能随时 soft/hard steer；denoise 与 hook 不得把模型喂成「空树」；长会话 compaction 有说明、有 marker |
| **P1** | **零门槛工作区** | **不强制 git**、**不强制 worktree**；默认在启动 cwd 直接读写；任意目录可跑（provenance `nogit`） |
| **P2** | **可证明的自改进** | 失败→regress→improve→eval→MergeGate；**仅**在 `xio improve` / trusted eval 等显式路径要求 git + candidate worktree |

**Git / worktree 是 opt-in 安全与合入能力**，不是产品身份前提。没有 git 照样 coding agent；没有 worktree 照样长会话与工具链。

---

## 产品定位

通用 coding agent（如 Claude Code）优化「这次帮你改完代码」。XioCode 在同等体感速度上再优化两件事：

> 1. **这次任务里，模型是否一直对准目标、少浪费轮次**  
> 2. **这次失败以后，属于你的 harness 是否变强**——且能证明、能回滚、须你同意才合入

「专属」指证据与改进资产属于使用者，不指云端为每人 fine-tune 一个黑盒模型。

| 专属来源 | 产品落点 |
|----------|----------|
| 你的失败 run | 轨迹与私有回归 case（`~/.xiocode/runs/` → 回归入口） |
| 你的仓库与失败家族 | 本地 suite / holdout，随使用累积 |
| 你的合入标准 | MergeGate + trusted capability gate |
| 你的模型选择 | 任意 provider；harness 与改进证据可迁移 |

冷启动时先靠公共 baseline 与最短「导入/标注第一条失败」路径；专属感来自之后累积的私有回归与能力曲线，不来自不可审计的神秘 prompt。

### 身份–行为缺口（纠偏进度）

北星已明确为 **快 + 不跑偏 + 零门槛 cwd**；自改进闭环是差异化，不是日常前置条件。2026-07 已交付：**性能套件 8/8**（early-boot first_frame P50~42ms、`--version` P50~25ms、Session WAL、provider 效率轴、eval 硬门禁 `default-gate.v1.2.0`）、**direct-cwd 默认**（`07-16-nongit-direct-cwd`；git/worktree 可选）、**模型对齐栈**（plan 模式、TodoEnforcer、ContextInjector、mid-turn steer、工具结果完整性、TUI scrollback + callId 配对）、**TUI 交互波**（markdown 定稿、`@` 文件引用、usage footer、`/model`、explore subagent 流式 UI）、**失败一键 capture 要约**（`07-16-failure-capture-hook`；仍须人确认）、**trusted eval 与交互 direct-cwd 解耦**、RuntimeEvent + stream-json、**H12 harness 设计标准**（事实源≠投影、turn snapshot/admission、写队列 + edit-before-read、follow-up、项目信任；`07-16-agent-harness-design-gaps` 6/6）、**Trellis 并行 A→B→C→Integrate**（`depends_on` / `dispatch-ready` / 默认 `xio` worker / `task.py integrate`）。仍未自动闭环：须用户显式 failure/verifier 与 MergeGate 同意。

**纠偏优先级（已交付的不回退）**：**启动与 provider 延迟回归** → **模型上下文可信（工具正文、steer、compaction marker）** → **direct-cwd 零门槛（非 git 可跑）** → **harness 设计标准（H12，教程语义）** → 证据完整性 → opt-in worktree 下 dirty-main 显式策略 → bash/MCP 风险门禁 → 失败→regress → private FIXED × trusted PASS 联合门禁 → eval/improve 隔离不随交互默认漂移。任务树：`.trellis/tasks/07-15-performance-board/`（8/8 archived）、`.trellis/tasks/07-15-agent-runtime-event-board.md`（5/5 done）、`07-16-agent-harness-design-gaps`（P1，**6/6 archived**）、`.trellis/tasks/archive/2026-07/07-16-trellis-parallel-task-orchestration/`（P2，A→B→C→Integrate **archived**）。

Claude/Cursor 兼容（MCP / skills / hooks）仍是市场准入，**不是**北星；G10 日常化入口已交付（含失败要约），不得写成全自动专属 harness，**更不得**把 git/worktree 写成默认前提。

公开产品树不携带本机 AI 规范文件（`AGENTS.md` / `CLAUDE.md` 等）；运行时仍可读**目标仓库**里的 `CLAUDE.md` / skills / hooks / MCP。`~/.xiocode` 只存 runtime 状态与配置。

---

## 目标用户与 JTBD

目标用户是希望在**任意本地目录**里获得**最快、最稳** coding agent 体验，并（可选）用私有失败史持续改进 harness 的 operator（个人或小团队）。**不要求** git 仓库；**不要求** worktree。

| JTBD | 默认路径 | 成功感 |
|------|----------|--------|
| **日常改码** | 启动 cwd 直接跑；流式 TUI；steer / plan / todo 保对齐 | 「比 Claude Code 更快上手、更少空转」 |
| **长任务** | compaction + resume + 完整 tool 上下文 | 模型不丢线索、不静默截断 |
| **（可选）自改进** | 失败→regress→`xio improve`（**此路径**才要 git + candidate worktree）→ eval → MergeGate | harness 可证明变强 |

成功不定义为「全面超越 Claude Code」，而定义为：**默认路径上体感更快、模型更贴任务**；在自改进 JTBD 上，通用 agent 结构性不拥有私有失败复利。

---

## 最终目标（五条）

### 1. 自有闭环

Agent loop、内置工具、LLM provider 客户端全部落在本仓 `src/runtime`，不依附外部 agent 产品（见 [ADR 0002](./adr/0002-remove-pi-agent.md)）。产品身份、发布节奏与工具行为由 XioCode 自己决定——否则「专属 harness」无法被使用者真正持有与修改。

### 2. 安全改码

默认在**启动时的工作区路径（cwd）**直接运行；**不强制 git**，**默认不进 worktree**。合入主树的隔离与 MergeGate 仅在显式开启 outer worktree 时生效（`[worktree] enabled = true`）。禁止「测绿即合」。

**默认主 cwd 模式**：

| 点 | 约定 |
|----|------|
| 工作区 | `path.resolve(启动 cwd)` — agent 读写就在用户当前目录 |
| Git | 可选；非 git 目录可启动（provenance `base_commit=nogit`） |
| 合入 | 无 worktree session → 无 MergeGate 外层合入路径 |

**Opt-in Worktree 语义（`[worktree] enabled = true`）**：

| 点 | 约定 |
|----|------|
| 启动根 | **启动时 cwd 所在 git 仓库**的 toplevel（`mainRoot`）；须为 git 仓 |
| 物理路径 | 固定在 `~/.xiocode/worktrees/<repoId>/<sessionId>`（`repoId` = mainRoot 路径哈希） |
| 内容 | `git worktree add` + **visible baseline tree** 物化；rename/symlink/mode/delete/untracked 由 Git 原生处理 |
| 身份 | `baselineTree` 持久化；session rollback 恢复 baseline |
| 合入 | clean：commit + merge。dirty baseline：仅应用 agent delta，保留主树 index；主树漂移 fail closed |

**诚实边界**：worktree 保护的是主树合入，**不是** OS sandbox。`bash` 与 MCP 默认可达宿主；`host_isolation: unsupported`。

**Dirty main**：仅 worktree 启用时生效 — 主树 dirty 则默认拒绝（须 `--allow-dirty` / `allow_dirty`）。

### 3. 可观测

每次 run 留下可回溯轨迹（`~/.xiocode/runs/`：events、trajectory、元数据）。Provider usage 在客户端边界规范化一次（input/output/cache/reasoning；不可得则为 `null`，不以字符数伪造）。**metadata 的 provider/model 与 usage 数值不得被密钥脱敏误伤**；否则私有回归与自改进没有可信原料。证据是专属 harness 的原料，不是装饰性日志。

**工具结果完整性**：`tool_result` hook（含 ResultDenoiser）必须吃到真实 content。agent-loop 发出的是 `{ call, result: { content } }` 嵌套形状；evolve 须同时兼容该形状与旧扁平 payload。**禁止** denoise/hook 把非空工具正文覆盖成空串（模型侧与 TUI 同步空白）。`emitToolResult` 对「原文非空、hook 返回空」拒绝覆盖。

### 4. 可自改进

在同一沙盒与合入模型下，用目标队列（T4）+ 候选 worktree 内真实 agent（无嵌套 worktree / 无内部 MergeGate）+ 候选内部 verifier（默认始终 `npm run check`，`--check` 只追加）+ **trusted capability gate** + 唯一外层 merge-ask 改**本仓自身**（`xio improve`）。生产 builtin seed 为 prompt-only；`scriptedChange` 仅测试/显式确定性输入。候选仓内 check/测试只作 advisory；trusted PASS/FAIL 由 `xio eval` 控制面在候选 worktree 外判定。外部评测失败可变成 Goal；外仓 patch **永不合入** xiocode。详见 [self-improve.md](./self-improve.md)。

专属改进必须落在可审计的 case、gate 与轨迹上，不落在不可复查的隐式个性化。

### 5. 诚实交付

文档与默认路径只承诺已交付能力。5-case 本地 smoke 证明 harness 可重复评测，**不是**竞品胜负或「已超越 Claude Code」。策略自迭代（StrategyLearner / PromptEvolver 等）须有真实 run 语料与评测设计后，再考虑显式开关上线——不预埋卖点。公开 npm / GitHub 树保持可安装、可瘦身，不把本机规范与测试垃圾打进默认包；`npm pack` / 发布前门禁须先 `npm run check`（typecheck），不能只检查打包文件是否存在。

**资源生命周期（已交付）**：MCP stdio 从 connect 起即有清理所有权（timeout / `listTools` 失败 / `session_end` 均有界 close+force-kill）。`xio resume --delete <id>` 在删除 metadata 前清理 checkpoint refs、注册 worktree 与专属 branch；身份不匹配 fail closed。

---

## 可执行指标（指针）

| 维度 | 如何度量 | 当前门槛 |
|------|----------|----------|
| **启动** | `xio bench run --all` → `startup.first_frame` / `startup.version` | first_frame P50~42ms；`--version` P50~25ms；回归不得静默回退 |
| **Provider 效率** | bench `provider.request` / `provider.first_token` / `provider.overhead` fixture | eval 硬门禁 `default-gate.v1.2.0` required 轴；live TTFT 503 记 concern 不放宽阈值 |
| **会话热路径** | Session WAL journal P95；TUI projection paint P95 | journal P95 ~4.3ms；projection P95≪25ms |
| **对齐（proxy）** | tool_result 非空率；steer 生效；compaction 后 resume marker | hook 不得抹空非空 tool 正文；空树类 bug 视为 P0 |
| 能力 | `xio eval compare` 在冻结 manifest 下的 holdout `task_resolved` | 无稳定回归，且至少一项稳定提升才可 trusted `PASS` |
| 安全 | forbidden / canary / secret 等 hard gate | 任一失败 → `FAIL`；infra 试验不进入 safety 分母 |
| 延迟（eval smoke） | 报告 wall / agent / grader 时间 | smoke 目标 2–5 分钟；首次 credentialed 实测后校准，不静默放宽 |
| 成本 | 规范化 usage + 版本化 price table → estimated cost | usage 或价格缺失 → `null` + concern |
| 基础设施 | provider/network/timeout/grader crash | `INFRA_ERROR`，不记入 task-resolved 分母 |
| 合入 | MergeGate（**仅 opt-in improve 路径**） | 仅 trusted `PASS` 可 ask；永不 auto-merge |
| 专属复利 | 同一私有失败家族上，合入前后的 holdout / 回归序列 | 有可展示的 before/after；无语料时不宣称「已个性化」 |

入口：`xio bench run --all --json`（日常性能）；`xio eval preflight|smoke|compare`（能力与门禁）。契约见 `.trellis/spec/runtime/trusted-capability-evaluation.md`。

---

## Agent harness 市场准入与 JD 对齐

> 本节把行业对 **agent harness / agent infra** 岗位的常见能力要求，映射成 XioCode 的产品缺口与目标。  
> 目的有两层：（1）补齐「市场准入条件」（见上文 JTBD）；（2）让本仓可作为可讲述的 harness 作品，而不是功能清单式 CLI。  
> **不**把「全面超越 Claude Code / Cursor」或「默认上 Docker / 多租户云平台」写成产品终点。

### 行业能力块（招聘侧常见）

| 能力块 | 岗位为何问 | XioCode 现状（相对 JD） |
|--------|------------|-------------------------|
| Agent loop + tool schema/dispatch | harness 本体 | ✅ 自有 `src/runtime` + 内置工具；流式 + 并行工具调度（H1–H5）；thinking 全档 + explore 并发策略 |
| Sandbox / 隔离 | coding agent 安全底线 | 🟡 **默认 direct-cwd，无 git 要求**；opt-in worktree + MergeGate + dirty-main；**host 级隔离 unsupported** |
| Permissions / lifecycle hooks | 危险动作门禁 | 🟡 合入门禁强；**user hooks MVP**；**G7 风险类 + 会话审批已交付**；**项目信任门（H12）已交付**（`[trust] mode`；非全量 Claude hooks） |
| Context / session / checkpoint | 长任务不崩 | ✅ 持久 chat/model + **G4 compaction** + **G5 execution/file resume** + 会话/turn rollback；**事实源≠投影 / turn snapshot / admission（H12）已交付** |
| Observability + cost | 生产可排障、可控费 | 🟡 轨迹 + usage 规范化 + **RuntimeEvent.v1 bus**（stream-json + evolve trajectory）；**价格表/成本曲线、span 级 tracing 未齐** |
| Eval harness | 评的是 model+harness | ✅ `xio eval` + capability gate + credentialed-series.v1；公开材料只写系列能证明的结论 |
| Private regression / failure flywheel | 少见但高信号 | ✅ `xio regress` + compare + G10 dogfood 默认（nudge / last-case / `[improve]`）；仍需显式 verdict + MergeGate ask |
| MCP / skills / AGENTS.md | 2026 生态标配 | ✅ tools-first MCP + 本地 skills + 目标仓 AGENTS/CLAUDE 注入；`disable` 跳过、stdio 可执行检查、close 超时；非 marketplace / 非全量 resources·prompts |
| Interactive TUI | 长会话可操作面 | ✅ Ink + **append-to-scrollback** + **markdown 定稿高亮** + **`@` 文件引用** + usage footer + `/model` + **callId 并行 tool 配对** + Ctrl+O + composer **steer** + explore **subagent 流式 UI** + early-boot 缓冲 + 结构化确认 + 隔离徽章 + 分层 ▸/⚙/● + diff/merge/rollback + bypass + resume |
| 多租户 / K8s / 队列规模 | 资深平台岗 | ❌ **产品非目标**（本地个人闭环优先）；面试需能讲升级路径，不在本仓默认交付 |

### 已具备、应作为对外叙事主轴的差异点

投递与口述时优先讲这些（相对「又一个 coding CLI」更稀缺）：

1. **自有 harness 闭环**，不挂外部 agent 产品  
2. **MergeGate**：合入权在人，禁止测绿即合  
3. **Trusted capability gate**（`xio eval`）：候选外独立证据，hidden grader  
4. **私有回归入口**（`xio regress`）：失败 run → 可审计 case  
5. **诚实边界**：stub smoke ≠ 能力宣称；`host_isolation: unsupported` 显式上报；dirty main 默认阻断，允许后镜像 WIP，不静默空 HEAD  


定位一句话（JD / 作品集用）：**本地、可审计、带 trusted eval 与合入门禁的 coding agent harness**——不是「Claude Code 替代品」。

### 欠缺与深化（相对中级 Agent Infra / Coding Agent JD）

下列是**仍缺或仅 MVP、且会削弱 JD 对齐**的项；实现优先级以 [ROADMAP.md](../ROADMAP.md) 为准。G1–G5 已有可演示实现（边界见 STATUS）；下表「现状」列区分 ✅ / 🟡 / 📋。

| ID | 缺口 | 为何卡 JD | 目标状态（完成定义） | 现状 |
|----|------|-----------|----------------------|------|
| G1 | MCP client | 工具生态面试标配 | Agent 可配置并调用 MCP tools；失败可观测、可拒绝 | ✅ MVP：stdio/SSE/HTTP；`mcp__*`；fail-open；`disabled` 跳过；stdio ENOENT 快失败；close 超时 + force-kill；进程退出 `exitCli` 兜底；非 resources/prompts/OAuth 全量 |
| G2 | User / lifecycle hooks | PreToolUse 类门禁是 harness 八股 | 至少支持工具调用前后 hook；可阻断危险动作 | ✅ MVP：Claude settings 子集四事件；command handler；PreToolUse exit 2 可阻断 |
| G3 | Skills / AGENTS.md 注入 | 与 AGENTS.md / skills 生态对齐 | 可发现并注入项目/用户 skills 与规格，行为可测 | ✅ MVP：本地 `SKILL.md` + `skill` tool；目标仓 AGENTS.md/CLAUDE.md 注入；公开产品树不自带规范文件；非 plugins market |
| G4 | Context compaction | 「窗口满了怎么办」必问 | 可演示的 compaction（或等价卸载）策略；长会话不静默截断无说明 | ✅ `/compact [focus]` + 自动 message-budget trigger；事务式同 provider summary；持久 resume marker；非 token 精确 `/context` |
| G5 | Session checkpoint-resume | 长任务 / 崩溃恢复 | 中断后可从持久状态恢复关键步骤，不丢合入边界 | ✅ 原子 v2 state；原 worktree attach；durable turn checkpoint；中断 tool completion unknown 且不重放；MergeGate 边界保留 |
| G5b | Session code rollback | 「改坏了怎么撤」必问 | 可回滚本会话 worktree 改动（会话起点或最新 turn）；不擅自改主树 | ✅ `/rollback` 恢复 immutable session baseline；`/rollback turn` 恢复 prompt 起点 Git tree checkpoint；均保留 chat |
| G6 | 隔离升级叙事与可选原型 | host isolation 被追问 | 文档写清 direct-cwd → opt-in worktree → container → microVM 阶梯；**默认路径是 direct-cwd**；评测报告继续诚实标 `unsupported`，除非某条可选路径真正落地 | 📋 |
| G7 | 工具风险分级 / 审批钩子 | 细粒度权限故事偏薄；与「安全改码」叙事冲突 | 危险 bash / 外发 / 宿主 MCP 等有明确风险类与审批点（不必复活 PathGuard）；默认不把 IDE MCP 面无门禁热插进 agent | ✅ 风险类 + plan 拒绝 write/exec/MCP；interactive 会话审批；`-p` 需 `--allow-high-risk`；`unknown_source_fail_closed`；仍非 OS sandbox |
| G8 | Cost + tracing 完整度 | 生产 harness 基本功 | 版本化 price table → 非 null 成本估计；关键 model/tool 跨度可追溯 | 📋 **证据 metadata/usage 已修**；价格表与 span tracing 仍待 |
| G9 | Credentialed 能力证据 | 无真实数字难过简历关 | 固定 provider/model 下可重复的 smoke/compare 序列；公开材料只写有证据的结论 | ✅ |
| G10 | 私有失败 → 改进默认路径 | 差异化尚未「日常化」 | 失败 run → 低摩擦 regress → private FIXED × trusted PASS → improve merge-ask 可 dogfood | ✅ 失败一键要约（turn-fail / hard steer / `/rollback`）+ `.last-case` + `[improve]` 默认；FIXED × PASS 仍 ask-only；case ≠ ImproveGoal；库仍薄 |
| G11 | Interactive TUI | 可讲述的操作面 | Ink/React：流式输出、工具行、slash、diff/权限、session resume | ✅ Core + **路线 B scrollback** + **markdown / `@` / usage / `/model`**（`07-16-tui-interaction-parity`）+ callId 配对 + Ctrl+O + composer **steer** + explore subagent 流 + early-boot + 结构化确认 + 隔离徽章 + diff/permission/bypass + resume。**不**宣称与 Pi/Claude/Codex 行为全量对齐 |
| H12 | Harness 设计标准（教程语义） | 生产 harness 八股：事实源≠投影、时间一致性、工具硬边界、项目信任 | 语义对齐 Agent 工程教程 ch07/08/09/10/12/15；增强现有 WAL，不照抄 JSONL 树 / SDK | ✅ **6/6 archived**（`07-16-agent-harness-design-gaps`）；ch13 SDK/RPC、JSONL 树、远程 Ops 仍 deferred — 见 STATUS 对齐表 |

### 面向 JD 的目标档位

| 档位 | 目标 | 本仓要做到 | 明确不做（本仓） |
|------|------|------------|------------------|
| A. 作品集 / 中级 coding-agent 岗 | 证明「能从零做完整 harness」 | 五条最终目标保持；**G1–G5、G5b、G9–G11 已交付**；叙事用差异点 1–5 | 不宣称全面超越商业产品 |
| B. Agent Infra 深挖 | 能答隔离、上下文、eval、失败恢复、harness 时间一致性 | 在 A 基础上 **H12 ✅**；再完成 **G6–G8** 的可讲述 + 可演示最小实现 | 不把 Docker 恢复为默认沙盒；不整仓抄教程文件形态 |
| C. 资深平台 / 多租户 harness | K8s、队列、多租户 SLA | **超出本产品终点**；仅保留「若平台化会如何切」的设计笔记即可；Trellis 并行编排是 **dev workflow**，不是产品多租户 | 不在默认路径做云协同专属或大规模编排 |

成功标准（JD 向，可自检）：

- 能用一张图把 XioCode 映射到行业七件套：loop / tools / context / sandbox / permissions / telemetry / eval，并标「已有 / 刻意不做 / 下一步」  
- 能在不吹竞品的前提下，用 MergeGate + `xio eval` + `xio regress` 讲完「如何把失败变成可证明的 harness 改进」  
- G1–G5、G5b、G9–G11、**H12** 已可演示；再投「Agent Harness / Agent Runtime」类岗位时，**G6–G8** 决定能否扛住系统设计深挖

近期执行拆条仍见 [ROADMAP.md](../ROADMAP.md)；交付是否完成以 [STATUS.md](./STATUS.md) 为准。

---

## 非目标

| 非目标 | 说明 |
|--------|------|
| 又一个薄包装 CLI | 不回到「spawn 外部 agent + 写对方配置」的形态 |
| 无同意自动合入主树 | 已撤销的 G4；会话与自改进路径统一 merge-ask |
| 默认路径上的策略自演进 | 当前默认 evolve 只做记录 / 降噪 / 注入 |
| 强制 git / 强制 worktree 才能启动 | 默认 direct-cwd；git 可选；worktree 仅 improve/eval 等显式路径 |
| Docker / 工具内权限引擎作默认沙盒 | 已删除；默认是 direct-cwd；opt-in worktree 保护主树合入。JD 对齐只要求可讲述的隔离阶梯，不要求恢复默认 Docker |
| 把外仓评测 patch 合进 xiocode | 外评只产生 Goal，只改本仓 harness |
| 用一次小样本 smoke 宣称全面超越竞品 | 本地基线只回答「这次 harness 是否变好」 |
| 云端黑盒「为你定制」 | 不上传全量私有轨迹换个性化；专属资产默认留在本地 |
| 不可审计的神秘 prompt 个性化 | 专属必须落在 case / gate / 轨迹，不落在说不清的隐式改写 |
| 一上来做多人云协同专属 | 先个人（或单机小团队）本地闭环；共享仅限脱敏后的 family 级回归 |
| 把资深多租户平台栈当作本仓交付终点 | K8s / 队列 / 多租户属于 JD 档位 C，不写入产品五条最终目标 |
| 在 xiocode 内嵌任务 DAG 引擎 | 依赖边与 ready-set 调度属 **Trellis**；xiocode 最多当并行 worker（Phase C） |
| 同 cwd 裸多写并行 | Trellis `isolation=worktree` 强制独立 cwd；`shared` 仅文档/只读类 |
| 把本机 AI 规范文件打进公开包 | 产品树与 npm payload 不携带 `AGENTS.md` / `CLAUDE.md` 等本机约定 |

---

## 与现状的关系

| 目标条 | 当前状态（摘要） |
|--------|------------------|
| 1 自有闭环 | ✅ `src/runtime` 已交付；流式 / 并行工具 / multi-explore / thinking 全档（H1–H5+）；tool_result 嵌套 payload 与 denoise 对齐 |
| 2 安全改码 | 🟡 **默认 direct-cwd（非 git 可跑）**；opt-in Worktree + MergeGate + dirty-main；**G7 工具风险门禁已交付**；host isolation 仍 unsupported |
| 快 + 对齐 | ✅ 性能 8/8 + early-boot + steer + tool 完整性 + plan/todo/compaction；bench/eval 硬门禁；TUI markdown/`@`/usage/`/model` |
| 3 可观测 | 🟡 轨迹落盘 + metadata/usage + **RuntimeEvent bus（stream-json + evolve）** + **工具正文不被 hook 抹空** + TUI usage footer；**G8 价格表 / span tracing 仍待** |
| 4 可自改进 | 🟡 MVP + trusted gate（**`default-gate.v1.2.0` 硬 perf 轴**）+ **private FIXED × PASS 联合门禁** + G10 dogfood（**失败一键要约**已交付；仍需显式 verdict / MergeGate ask） |
| 5 诚实交付 | ✅ 以 STATUS 为准；stub = harness-only；公开树可安装且瘦身；身份–行为缺口写明；**性能套件 8/8 archived**；TUI 采用 scrollback 路线且不宣称未测的竞品全量对齐；交互 direct-cwd 与 trusted eval worktree 分合同 |
| 专属 harness | 🟡 日常入口 + 失败要约已交付；case ≠ goal、无自动 capture/merge；回归库仍薄；见 STATUS known gaps |
| Harness 设计标准（H12） | ✅ `07-16-agent-harness-design-gaps` **6/6 archived**（事实源/投影、turn snapshot、写队列、follow-up、项目信任 + integration gate）；SDK/RPC / JSONL 树 / 远程 Ops deferred |
| Trellis 任务 DAG（dev workflow） | ✅ A→B→C→Integrate：`depends_on` + ready/drift；`dispatch-ready`；默认 `xio` worker；`task.py integrate` 父集成闸门（调度在 Trellis，xiocode 不内嵌 DAG） |
| JD 对齐 A | ✅ G1–G5、G5b、G9–G11、H12 已交付；公开能力声明仍受 series 证据约束 |
| JD 对齐 B（G6–G8） | 🟡 G7 ✅；H12 ✅；G6/G8 仍待；叙事不得掩盖 bash 宿主可达 |
| JD 对齐 C | ❌ 产品非目标；仅面试升级路径 |

近期待办 **P0 纠偏**（direct-cwd 默认、性能 8/8、steer、tool 完整性、TUI scrollback、eval 隔离解耦、TUI 交互四缺口、失败 capture 要约）与 **H12 harness 设计标准（6/6）** 已收尾。后续主线：

1. **持续压启动与 provider 延迟**：bench 回归不退化；discovery/schema 缓存与 WAL 热路径保持 O(delta)。
2. **模型对齐可观测**：tool 正文进上下文、steer、compaction marker 的可测 proxy；空树/并行 tool 串台类 bug 按 P0 处理。
3. **Trellis 任务 DAG（P2）**：A→B→C→Integrate 已交付并归档（`depends_on` / `dispatch-ready` / 默认 `xio` worker / `task.py integrate`；`.trellis/tasks/archive/2026-07/07-16-trellis-parallel-task-orchestration/`）。**产品非目标**：xiocode 内嵌多租户队列；同 cwd 多写并行。
4. **Agent Runtime Event follow-up**：bus→TUI UI、`reportProgress()`。
5. 真实 run/regress 语料、G6 隔离阶梯叙事（**默认 direct-cwd**）、G8 成本与 tracing、credentialed 系列的诚实展示。

其余见 [ROADMAP.md](../ROADMAP.md) 与 [STATUS.md](./STATUS.md)。

---

## 设计哲学（指针）

Harness 是模型与现实世界之间的翻译器：构造动作空间、管理上下文、不对称安全、暴露可执行错误、可观测回溯、适配不同模型能力。对 XioCode，这份翻译器还应随**使用者自己的失败史**变厚，且每次变厚都留下可证明的证据。历史长文见 [archive/HARNESS.md](./archive/HARNESS.md)（快照，部分实现对照已过期；以本文件 + STATUS 为准）。
