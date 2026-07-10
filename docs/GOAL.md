# XioCode 最终目标

> 产品终点的单一真相源。交付快照见 [STATUS.md](./STATUS.md)；近期待办见 [ROADMAP.md](../ROADMAP.md)。

**更新日期**：2026-07-11

---

## 一句话

把 XioCode 做成**每个人专属的本地 harness**：用你自己的失败史持续改进 agent，证据留在本地，合入权始终在你手里。它是可观测、可回滚、可自改进的编码 agent 闭环，不是又一个聊天式 coding CLI，也不是大家共用的通用 agent。

---

## 产品定位

通用 coding agent（如 Claude Code）优化「这次帮你改完代码」。XioCode 优化另一件事：

> 这次失败以后，**属于你的 harness** 是否变强——且能证明、能回滚、须你同意才合入。

「专属」指证据与改进资产属于使用者，不指云端为每人 fine-tune 一个黑盒模型。

| 专属来源 | 产品落点 |
|----------|----------|
| 你的失败 run | 轨迹与私有回归 case（`~/.xiocode/runs/` → 回归入口） |
| 你的仓库与失败家族 | 本地 suite / holdout，随使用累积 |
| 你的合入标准 | MergeGate + trusted capability gate |
| 你的模型选择 | 任意 provider；harness 与改进证据可迁移 |

冷启动时先靠公共 baseline 与最短「导入/标注第一条失败」路径；专属感来自之后累积的私有回归与能力曲线，不来自不可审计的神秘 prompt。

---

## 目标用户与 JTBD

目标用户是维护长期、私有或不可上传完整运行证据的代码仓库，并希望用自己的失败历史持续改进本地 coding agent 的 operator（个人或小团队）。

要赢下的 Job-to-be-Done：把一次本地 agent 失败转成可审计回归，在隔离 worktree 中修改 XioCode 自身，用候选改动之外的独立证据比较修改前后，最后由用户决定是否合入。模型、MCP、流式 UI、上下文压缩和基础工具是市场准入条件（缺口与 JD 档位见下文「Agent harness 市场准入与 JD 对齐」）；**每人一份可累积、可证明、可回滚的 harness 资产**才是差异化。

成功不定义为「全面超越 Claude Code」，而定义为：在上述 JTBD 上，使用者默认选择 XioCode，因为通用 agent 结构性不拥有其私有失败复利。

---

## 最终目标（五条）

### 1. 自有闭环

Agent loop、内置工具、LLM provider 客户端全部落在本仓 `src/runtime`，不依附外部 agent 产品（见 [ADR 0002](./adr/0002-remove-pi-agent.md)）。产品身份、发布节奏与工具行为由 XioCode 自己决定——否则「专属 harness」无法被使用者真正持有与修改。

### 2. 安全改码

会话在外层 git worktree 中隔离（`~/.xiocode/worktrees/...`）。合入主树必须经用户 **MergeGate** 同意（`/merge` 或会话结束询问）。禁止「测绿即合」。非 git 目录硬失败，不进入 agent loop。worktree 不是 OS sandbox；`host_isolation` 在评测报告中标为 `unsupported`。

### 3. 可观测

每次 run 留下可回溯轨迹（`~/.xiocode/runs/`：events、trajectory、元数据）。Provider usage 在客户端边界规范化一次（input/output/cache/reasoning；不可得则为 `null`，不以字符数伪造）。证据是专属 harness 的原料：调试、信任、私有回归与后续演进，不是装饰性日志。

### 4. 可自改进

在同一沙盒与合入模型下，用目标队列（T4）+ 候选内部 verifier + **trusted capability gate** + merge-ask 改**本仓自身**（`xio improve`）。候选仓内的 `npm run check` / 测试只作 advisory；trusted PASS/FAIL 由 `xio eval` 控制面在候选 worktree 外判定。外部评测失败可变成 Goal；外仓 patch **永不合入** xiocode。详见 [self-improve.md](./self-improve.md)。

专属改进必须落在可审计的 case、gate 与轨迹上，不落在不可复查的隐式个性化。

### 5. 诚实交付

文档与默认路径只承诺已交付能力。5-case 本地 smoke 证明 harness 可重复评测，**不是**竞品胜负或「已超越 Claude Code」。策略自迭代（StrategyLearner / PromptEvolver 等）须有真实 run 语料与评测设计后，再考虑显式开关上线——不预埋卖点。

---

## 可执行指标（指针）

| 维度 | 如何度量 | 当前门槛 |
|------|----------|----------|
| 能力 | `xio eval compare` 在冻结 manifest 下的 holdout `task_resolved` | 无稳定回归，且至少一项稳定提升才可 trusted `PASS` |
| 安全 | forbidden / canary / secret 等 hard gate | 任一失败 → `FAIL`；infra 试验不进入 safety 分母 |
| 延迟 | 报告 wall / agent / grader 时间 | smoke 目标 2–5 分钟；首次 credentialed 实测后校准，不静默放宽 |
| 成本 | 规范化 usage + 版本化 price table → estimated cost | usage 或价格缺失 → `null` + concern |
| 基础设施 | provider/network/timeout/grader crash | `INFRA_ERROR`，不记入 task-resolved 分母 |
| 合入 | MergeGate | 仅 trusted `PASS` 可 ask；永不 auto-merge |
| 专属复利 | 同一私有失败家族上，合入前后的 holdout / 回归序列 | 有可展示的 before/after；无语料时不宣称「已个性化」 |

入口：`xio eval preflight|smoke|compare`；契约见 `.trellis/spec/runtime/trusted-capability-evaluation.md`。

---

## Agent harness 市场准入与 JD 对齐

> 本节把行业对 **agent harness / agent infra** 岗位的常见能力要求，映射成 XioCode 的产品缺口与目标。  
> 目的有两层：（1）补齐「市场准入条件」（见上文 JTBD）；（2）让本仓可作为可讲述的 harness 作品，而不是功能清单式 CLI。  
> **不**把「全面超越 Claude Code / Cursor」或「默认上 Docker / 多租户云平台」写成产品终点。

### 行业能力块（招聘侧常见）

| 能力块 | 岗位为何问 | XioCode 现状（相对 JD） |
|--------|------------|-------------------------|
| Agent loop + tool schema/dispatch | harness 本体 | ✅ 自有 `src/runtime` + 内置工具 |
| Sandbox / 隔离 | coding agent 安全底线 | 🟡 worktree + MergeGate 已有；**host 级隔离 unsupported** |
| Permissions / lifecycle hooks | 危险动作门禁 | 🟡 合入门禁强；工具级 PermissionEngine 已删；**user hooks 未交付** |
| Context / session / checkpoint | 长任务不崩 | 🟡 session / 轨迹有；**compaction、prompt-cache 优化、正式 checkpoint-resume 未交付** |
| Observability + cost | 生产可排障、可控费 | 🟡 轨迹 + usage 规范化有；**价格表/成本曲线、span 级 tracing 未齐** |
| Eval harness | 评的是 model+harness | ✅ `xio eval` + capability gate；🟡 credentialed 序列与公开数字不足 |
| Private regression / failure flywheel | 少见但高信号 | ✅ `xio regress` MVP；🟡 日常默认路径与 before/candidate 评估未闭环 |
| MCP / skills / subagents | 2026 生态标配 | ❌ / 🟡 未交付或仅规划（见 ROADMAP / Trellis tasks） |
| 多租户 / K8s / 队列规模 | 资深平台岗 | ❌ **产品非目标**（本地个人闭环优先）；面试需能讲升级路径，不在本仓默认交付 |

### 已具备、应作为对外叙事主轴的差异点

投递与口述时优先讲这些（相对「又一个 coding CLI」更稀缺）：

1. **自有 harness 闭环**，不挂外部 agent 产品  
2. **MergeGate**：合入权在人，禁止测绿即合  
3. **Trusted capability gate**（`xio eval`）：候选外独立证据，hidden grader  
4. **私有回归入口**（`xio regress`）：失败 run → 可审计 case  
5. **诚实边界**：stub smoke ≠ 能力宣称；`host_isolation: unsupported` 显式上报  

定位一句话（JD / 作品集用）：**本地、可审计、带 trusted eval 与合入门禁的 coding agent harness**——不是「Claude Code 替代品」。

### 欠缺（相对中级 Agent Infra / Coding Agent JD）

下列是**产品上仍缺、且会直接削弱 JD 对齐**的项；实现优先级以 [ROADMAP.md](../ROADMAP.md) 为准，本节定义「做到什么算对齐」。

| ID | 缺口 | 为何卡 JD | 目标状态（完成定义） |
|----|------|-----------|----------------------|
| G1 | MCP client | 工具生态面试标配 | Agent 可配置并调用 MCP tools；失败可观测、可拒绝 |
| G2 | User / lifecycle hooks | PreToolUse 类门禁是 harness 八股 | 至少支持工具调用前后 hook；可阻断或改写危险动作并留证据 |
| G3 | Skills discovery / 注入 | 与 AGENTS.md / skills 生态对齐 | 可发现并注入项目/用户 skills，行为可测 |
| G4 | Context compaction | 「窗口满了怎么办」必问 | 可演示的 compaction（或等价卸载）策略；长会话不静默截断无说明 |
| G5 | Session checkpoint-resume | 长任务 / 崩溃恢复 | 中断后可从持久状态恢复关键步骤，不丢合入边界 |
| G6 | 隔离升级叙事与可选原型 | host isolation 被追问 | 文档写清 worktree → container → microVM 阶梯与威胁模型；**默认路径仍是 worktree**；评测报告继续诚实标 `unsupported`，除非某条可选路径真正落地 |
| G7 | 工具风险分级 / 审批钩子 | 细粒度权限故事偏薄 | 危险 bash / 外发 / 合入等有明确风险类与审批点（不必复活已删 PathGuard 全量设计） |
| G8 | Cost + tracing 完整度 | 生产 harness 基本功 | 版本化 price table → 非 null 成本估计；关键 model/tool 跨度可追溯 |
| G9 | Credentialed 能力证据 | 无真实数字难过简历关 | 固定 provider/model 下可重复的 smoke/compare 序列；公开材料只写有证据的结论 |
| G10 | 私有失败 → 改进默认路径 | 差异化尚未「日常化」 | 失败 run → regress →（可选）improve/gate 的最短操作路径可 dogfood |

### 面向 JD 的目标档位

| 档位 | 目标 | 本仓要做到 | 明确不做（本仓） |
|------|------|------------|------------------|
| A. 作品集 / 中级 coding-agent 岗 | 证明「能从零做完整 harness」 | 五条最终目标保持；补齐 **G1–G5、G9–G10**；叙事用差异点 1–5 | 不宣称全面超越商业产品 |
| B. Agent Infra 深挖 | 能答隔离、上下文、eval、失败恢复 | 在 A 基础上完成 **G6–G8** 的可讲述 + 可演示最小实现 | 不把 Docker 恢复为默认沙盒 |
| C. 资深平台 / 多租户 harness | K8s、队列、多租户 SLA | **超出本产品终点**；仅保留「若平台化会如何切」的设计笔记即可 | 不在默认路径做云协同专属或大规模编排 |

成功标准（JD 向，可自检）：

- 能用一张图把 XioCode 映射到行业七件套：loop / tools / context / sandbox / permissions / telemetry / eval，并标「已有 / 刻意不做 / 下一步」  
- 能在不吹竞品的前提下，用 MergeGate + `xio eval` + `xio regress` 讲完「如何把失败变成可证明的 harness 改进」  
- G1–G5 有可运行证据后，再投「Agent Harness / Agent Runtime」类岗位；G6–G8 决定能否扛住系统设计深挖  

近期执行拆条仍见 [ROADMAP.md](../ROADMAP.md)；交付是否完成以 [STATUS.md](./STATUS.md) 为准。

---

## 非目标

| 非目标 | 说明 |
|--------|------|
| 又一个薄包装 CLI | 不回到「spawn 外部 agent + 写对方配置」的形态 |
| 无同意自动合入主树 | 已撤销的 G4；会话与自改进路径统一 merge-ask |
| 默认路径上的策略自演进 | 当前默认 evolve 只做记录 / 降噪 / 注入 |
| Docker / 工具内权限引擎作默认沙盒 | 已删除；默认沙盒模型是外层 worktree。JD 对齐只要求可讲述的隔离阶梯与可选路径，不要求恢复默认 Docker |
| 把外仓评测 patch 合进 xiocode | 外评只产生 Goal，只改本仓 harness |
| 用一次小样本 smoke 宣称全面超越竞品 | 本地基线只回答「这次 harness 是否变好」 |
| 云端黑盒「为你定制」 | 不上传全量私有轨迹换个性化；专属资产默认留在本地 |
| 不可审计的神秘 prompt 个性化 | 专属必须落在 case / gate / 轨迹，不落在说不清的隐式改写 |
| 一上来做多人云协同专属 | 先个人（或单机小团队）本地闭环；共享仅限脱敏后的 family 级回归 |
| 把资深多租户平台栈当作本仓交付终点 | K8s / 队列 / 多租户属于 JD 档位 C，不写入产品五条最终目标 |

---

## 与现状的关系

| 目标条 | 当前状态（摘要） |
|--------|------------------|
| 1 自有闭环 | ✅ `src/runtime` 已交付 |
| 2 安全改码 | ✅ WorktreeSandbox + MergeGate；host isolation unsupported |
| 3 可观测 | ✅ TrajectoryRecorder + RunStore + provider usage；需积累真实语料与价格快照 |
| 4 可自改进 | ✅ MVP + 本地 trusted baseline（`xio eval`）+ opt-in `--capability-gate`；credentialed 长期序列与外部 benchmark 尚未建立 |
| 5 诚实交付 | ✅ 以 STATUS 为准；stub smoke = harness-only |
| 专属 harness | 🟡 定位已写入本文件；私有失败 → 回归入口与长期个人能力曲线尚未成为默认日常路径 |
| JD 对齐 A（G1–G5、G9–G10） | 🟡 eval/regress/merge 叙事已有；MCP / hooks / skills / compaction / checkpoint / credentialed 证据仍缺 |
| JD 对齐 B（G6–G8） | 📋 隔离阶梯文档与 cost/tracing 完整度待补 |
| JD 对齐 C | ❌ 产品非目标；仅面试升级路径 |

近期待办（credentialed capability series、语料、私有回归入口、MCP/hooks/skills、外评接线、REPL 打磨等）服务于上述终点与 JD 档位 A/B，见 [ROADMAP.md](../ROADMAP.md)。

---

## 设计哲学（指针）

Harness 是模型与现实世界之间的翻译器：构造动作空间、管理上下文、不对称安全、暴露可执行错误、可观测回溯、适配不同模型能力。对 XioCode，这份翻译器还应随**使用者自己的失败史**变厚，且每次变厚都留下可证明的证据。历史长文见 [archive/HARNESS.md](./archive/HARNESS.md)（快照，部分实现对照已过期；以本文件 + STATUS 为准）。
