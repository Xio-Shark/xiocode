# Self-Improve 闭环的疑问清单

> 关于「失败 → 总结 → 优化 xicode/开发规范 → 验证 → 合并」这条自我改进闭环，
> 当前实现下的未解疑问。记录于 2026-07-31，用于后续想清楚再动手。
>
> **2026-07-31 更新**：经任务 `07-31-self-improve-verification-gaps` 核实/落地，
> 部分疑问已有结论，见文末「结论」与 `docs/self-improve.md` §Verification boundary。
> 同日第二次核实（全仓搜索）：阈值 2/3 次从未实现，已在「结论」中关闭该问。
> 同日第三次处置：剩余三项悬置（题型覆盖面 / 人审复核清单 / infra 归类边界）
> 全部落文档关闭，见文末「2026-07-31 第三次处置结果」。

---

## 1. 怎么确定优化有效，而不是过拟合

闭环的验证链是：

```
失败 → 总结 → 改 xicode 代码/开发规范 → 验证 → 人审合并
```

疑问：**怎么证明这次优化学到了泛化能力，而不是只记住了那一个失败 case？**

当前防线（读代码所得）：
- dev/holdout 分离（同类问题、不同实例，holdout 全程不可见）
- Grader 独立进程（agent 碰不到评分逻辑）
- before/after 对比（相对基线看增量）
- 冻结门禁清单（agent 改不了评分标准）
- 私有回归 joint gate（私有 case FIXED × 能力 PASS 双门禁）
- MergeGate 人审（机器过了还要人点头）

存疑的点：
- holdout 只有 4 张，样本太少，统计上站不住
- 每次只考一次，没考多次看分布（agent 有随机性，单次通过可能是运气）
- 没有"负样本监控"：改 A 修好、改坏 B 怎么办？门槛是否要求"目标类上升 + 全量 holdout 不降"双条件？

---

## 2. 考试卷（holdout fixture）是什么

- 写死在 `extensions/xio-eval/src/fixtures.ts` 里的 4 张考试卷 + 4 张练习卷
- 由模板函数批量"印"出：同一题型换函数名、文件名、测试数字
- 五类题型：修 bug（clamp）、跨文件契约、CLI 行为、测试驱动修复、越界安全
- 每张卷子 = 小项目（有 bug 的代码 + 任务描述 + 藏在评分器手里的标准答案 + 考点 + 禁区）
- 加载器强制：每类题必须同时有 dev 和 holdout 两个变体，少一个报错

疑问：
- 这些题型是谁定的？依据是什么？
- 4 张卷子能代表"agent 的通用能力"吗？覆盖了哪些能力、漏了哪些？

---

## 3. 评分器（grader）是什么

- 独立进程，对 agent 改完的代码做 4 项检查：
  1. 类型检查（tsc --strict）
  2. 行为测试（f2p：该修的修好没；p2p：别的功能坏没）
  3. 禁区检查（forbidden_paths 逐字节比对 + canary 金丝雀文件）
  4. 综合判定 task_resolved
- 标准答案（oracle_files）只在评分器侧，agent 目录里没有

疑问：
- 评分器只测"代码行为"，测不了"agent 行为"（比如是否先读再改、是否遵守规范）？
- 对"开发规范"（AGENTS.md / norms）类改动，评分器能验证吗？如果不能，规范类优化靠什么验证？

---

## 4. 核心疑问：固定模板考试卷和具体项目错误有什么关系

这是最大的疑问。

- **具体项目的错误**走的是另一条路：失败捕获 → 私有回归用例（真实 prompt + 真实项目现场）→ `xio improve --private-case` → FIXED
- **考试卷**是固定模板的通用能力测试，不包含任何 xicode 具体项目的错误

疑问：
- 考试卷和真实失败是**两个平行世界**：一个管"这道题会了吗"，一个管"能力还在吗"。它们之间没有桥？
- 理想的闭环是不是应该是：**真实失败 → 归约成一个能力维度 → 为这个维度造一张考试卷（换皮）**，让考试卷库跟着真实失败一起长？
- 现在的五类固定模板不是从 xicode 真实失败里提炼的，这个 gap 怎么补？
- 私有回归用例能不能自动归约成新题型？还是必须人工设计？

---

## 5. 其他悬而未决

- ~~同一种失败要出现 2 次警告、3 次才允许改进——这个阈值是怎么定的？合理吗？~~
  **已核实关闭（2026-07-31）：该阈值从未在代码中实现**，见文末处置结果。
- 基础设施错误（网络/超时）单独归类不进能力池——归类规则在哪，会不会误判？
- 改进"开发规范"和"改 xicode 代码"的验证方式是否应该不同？规范影响 prompt 层，行为变化是间接的，现有 fixture 能捕获吗？
- 门禁全过后是"人审合并"——人对机器验证结果的信任边界在哪？人怎么复核？

---

## 结论（当前状态）

- 现有设计有防过拟合的骨架：dev/holdout 分离 + 独立 grader + before/after + 人审
- 但**验证链和真实失败之间缺一座桥**：考试卷不是从项目失败里长出来的
- 要回答"优化确实有效"，还差三块：holdout 数量与多次运行分布、负样本监控、规范类改动的行为级验证

### 2026-07-31 处置结果（逐条对齐）

- **负样本监控（疑问 1）——核实为已实现，非缺口**：`compareSummaries` 本就跑全量 holdout，
  任一张 before PASS → candidate FAIL 即 `stable capability regression` 硬 FAIL 并点名 case；
  本次补了 comparator 级直接单测固化该行为（gate.test.ts）。
- **多次运行分布（疑问 1）——已打通到 improve 闭环**：eval 侧早有 `--repeat`（含分歧自适应加跑）；
  新增 `xio improve --eval-repeat N` / `[improve] eval_repeat`（1-10）透传 capability gate；
  不稳定结果不判回退也不判改进，INFRA_ERROR 不入分母。
- **考试卷↔真实失败的桥（疑问 4）——落地半自动换皮**：`xio eval draft --private-case <id|last>`
  从 FIXED 的私有用例生成 dev+holdout 成对模板草稿（repo 外），人审脱敏后手工入 fixtures.ts；
  loader 成对校验即入库门禁，永不自动合入。improve 流程在 FIXED 时会提示该命令。
- **规范类改动验证（疑问 3/5）——声明为设计边界**：grader 只测代码行为；规范类改动走
  私有回归 FIXED + 人审，不走 fixture（见 docs/self-improve.md §Verification boundary）。
- **阈值 2 次警告/3 次改进（疑问 5）——全仓核实：从未实现，关闭此问**：
  `src/runtime/failure-capture-offer.ts` 仅按 turnId 做会话内去重（`offeredTurns` Set，内存态），
  无任何跨会话失败计数；git 历史亦无此设计。实际防噪靠人工触发（`/regress`、`xio improve`
  runLoop 不自动跑）+ `offerOnFailure` kill-switch。若未来要自动化触发，需先持久化失败签名计数。
- **仍悬而未决**：holdout 题型覆盖面评估（疑问 2）、人审复核清单（疑问 5）、
  基础设施错误归类规则的判定细节（疑问 5，`run-ledger` 已有 `infra_error` 类型但边界未文档化）。

### 2026-07-31 第三次处置结果（关闭剩余三项）

三项核实结论一致：**代码行为已就位，缺的只是文档**，故全部以文档落地关闭，不改代码。

- **holdout 题型覆盖面（疑问 2）——已评估并落文档**：五类 family（local-bug /
  cross-file-contract / cli-behavior / test-and-repair / scope-safety）的
  「family → 能力维度 → grader kind」映射表 + 已知未覆盖清单（大仓导航、多轮交互、
  并发异步、性能、依赖配置、prompt 层规范）已写入 docs/self-improve.md
  §Verification boundary。题型由五个模板函数定义（fixtures.ts），依据是「换皮同题」
  防记答案；明确声明「4 张 holdout 全绿 ≠ 通用能力证明」，扩面靠 draft 换皮入库。
- **人审复核清单（疑问 5）——已落文档**：docs/self-improve.md §Merge policy 新增
  「MergeGate 人审复核清单」：门禁状态行 → 看 diff 本体（扫吞错/mock/无关重构）→
  冻结面检查（diff 不碰 extensions/xio-eval/src/**，否则评分标准漂移）→ 证据新鲜度
  （checkMergeEligibility 已机器保证，人用 `xio improve status` 复核）→ 拒绝无成本。
  信任边界一句话：grader 只回答代码行为，diff 的意图正当性与冻结面完整性归人。
- **infra_error 归类边界（疑问 5）——已文档化**：判定是结构性状态匹配（执行状态 /
  worktree 信任校验 / 无可评分 worktree / grader 不可运行四来源），不做错误文案正则；
  infra 不入分母（summarizeCandidate）、任一侧 infra → 整体 INFRA_ERROR 拒绝比较
  （exit 3）；ledger 侧 terminal `infra_error` 是另一层。误判方向 fail-closed。
  已写入 docs/self-improve.md §Verification boundary。
- **补充澄清（防误读）**：run-ledger 存在 `FAILURE_SIGNATURE_WARN_AT=2 / STOP_AT=3`
  （run-ledger/types.ts R6），但那是 improve 运行**重复失败的刹车**（同签名失败 2 次警告、
  3 次强停须 override），与本清单疑问 5 所问「失败出现 2/3 次才**触发**改进」方向相反，
  互不矛盾；「触发侧阈值从未实现」的结论维持不变。

至此本清单所有疑问均已关闭或声明为设计边界，无悬置项。
