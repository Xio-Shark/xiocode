# 路线 B 产品化计划：把 XioCode 做成成熟可用的用户产品

> 战略切换（2026-07-26）：放弃「作品集收尾」路线（原 `ROUTE-A-FINALIZATION.md`，已删除），
> 正式以**真实外部用户的采用与留存**为最高目标。
> 本文档是产品化阶段的唯一执行清单。**核心纪律：用户抱怨是唯一路线图；没有用户信号的功能一律不做。**

**关联文档**：[GOAL.md](./GOAL.md)（需按第 2 节收缩改写）· [STATUS.md](./STATUS.md) · [ROADMAP.md](../ROADMAP.md)

---

## 一、「成熟可用」的定义（可度量，不许模糊）

| 维度 | 达标线 |
|------|--------|
| 安装 | 任一渠道（npm / install.sh）在干净的 macOS + Linux 机器上一次成功；失败信息可执行。注意：干净机器上没有 Node 22.6+，install.sh 必须兜住 Node 本身（见 3.3），否则此条盲测第一分钟即红 |
| 平台 | 支持矩阵显式声明（README + doctor）：macOS / Linux ✅；Windows → 建议 WSL、未测试 |
| 首次体验 | 新用户从安装到完成第一个真实任务 ≤ 5 分钟，无需读文档 |
| 成本 | 每个 turn / 会话显示真实美元成本，不是 `null` |
| 可靠 | 崩溃后 `xio resume` 必定可恢复；crash 附带可提交的诊断输出 |
| 丝滑 | 长会话流式期无可感知卡顿/闪烁；滚动与搜索用终端原生能力；绘制层有 bench 基线护栏（见 3.6） |
| 安全 | 默认路径下危险命令有可解释的拦截层，不只靠"文档里写了诚实边界" |
| 用户 | ≥ 10 个非本人用户在真实仓库使用；≥ 4 人第二周仍在用 |
| 反馈 | issue 有模板、48h 内响应；每 1–2 周一个发版节奏 |

**当前状态对照**：前 5 项部分达标或未达标；后 2 项为 0。差距主要不在代码量，在方向。

---

## 二、Phase 0 · 战略收缩（第 1 周）

成熟产品来自窄而深。当前 8 个子系统里有一半不服务日常用户。

### 2.1 砍面（移出默认叙事，代码冷冻不删除）

| 项 | 处置 |
|----|------|
| `xio eval` / `xio regress` / `xio improve` / 自改进飞轮 | 移出 README 与主叙事；CLI 保留但标 experimental；不再投入开发 |
| Ultra parallel DAG / Trellis bridge | 同上 |
| GOAL.md 的 JD 对齐章节（§Agent harness 市场准入） | 移出产品树（迁至 career 私有目录）；GOAL 改写为纯用户价值表述 |
| explore 多子代理 | 保留（服务日常速度），但不再加参数面 |

### 2.2 重新定位（决策，已定）

**一句话**：*本地优先、BYOK、崩溃也不丢现场的终端 coding agent——你的代码不上传，合入权永远在你手里。*

**差异化钩子（主打，按可感知程度排序）**：
1. **长会话韧性**——WAL + checkpoint + resume + `/rollback`：中断、崩溃、改坏都能回来（现有最深技术资产，用户第一天可体感）
2. **本地与隐私**——无云端 agent 服务、evidence 全在 `~/.xiocode/`、任意 provider BYOK
3. **合入权在人**——opt-in worktree + MergeGate、diff 确认、永不自动合入

**目标用户**：终端重度使用者；对代码隐私敏感（不能用云 agent 的公司/个人）；多 provider 切换需求（DeepSeek/国产模型用户是天然缝隙市场——头部竞品对其支持二等）。

### 2.3 文档面收缩

- README 面向用户重写：钩子 1–3 置顶，删除 harness/JD 词汇（"trusted capability gate" 这类词用户不关心）
- GOAL.md 压缩为一页用户价值 + 非目标；工程细节留 STATUS

**验收**：README 里不再出现 eval/regress/improve/JD；一个陌生开发者 3 分钟能说出"这工具是干嘛的、为什么用它"。

---

## 三、Phase 1 · 生产基本功（第 2–5 周）

只收敛为以下六项，全部直接服务留存。

**执行顺序（按「离用户第一分钟的距离」排，不按编号）**：
第 2 周 3.3（漏斗最上游，先堵最大的洞）→ 第 3 周 3.1 + 3.6 P0（路线切换 + live 行数上限，两处小改）→ 第 4 周 3.2（仅命令正则层）+ 3.6 P1 → 第 5 周 3.4 + 两轮盲测修卡点（盲测放最后，测的是完整链路）。

### 3.1 成本可见（G8 解冻，P0）

- 版本化 price table（内置常见 provider/model 单价 + 用户可覆盖 `[pricing]` 配置）
- usage footer 与 `-p` 输出显示每 turn / 会话累计美元；未知模型显示 `~unknown` 而非空
- **验收**：`xio -p "task"` 结束能看到 `$0.0042` 级别的真实数字

### 3.2 安全默认值加固（P0）

- bash 工具增加命令级风险识别（`rm -rf` / `curl|sh` / `git push --force` 类模式 → 强确认），在现有 G7 风险类之下做命令正则层
- **docker backend 移入 backlog（决策）**：`[sandbox] backend = "docker"` 是零用户信号功能，直接违反本计划最高纪律「没有用户信号的功能一律不做」；且「最小 docker run 包装」是著名的坑（挂载权限 / macOS FS 性能 / 网络 / podman·orbstack 兼容），会吃掉半个 Phase 1。等第一个用户说出口再解冻；README 只保留隔离阶梯叙事（direct-cwd → worktree → container）
- **验收**：默认模式下模型发起 `rm -rf ~` 必被拦截确认

### 3.3 Onboarding 与首任务成功率（P0）

- `xio`（无配置首启）→ 引导式 `/connect` → 建议第一个任务，全程 ≤ 5 分钟
- **install.sh 兜住 Node 本身**：检测版本 → 给出该平台一行安装命令（或经 fnm/volta 引导安装）。这是安装漏斗的第一杀手，v2ex/linux.do 受众里老 Node 环境密度高
- `xio doctor`：一条命令自检——**Node 版本检查放第一位**——配置 / 密钥 / provider 连通性，输出可粘贴到 issue
- 平台支持矩阵写进 README 与 doctor 输出（macOS/Linux ✅，Windows → WSL），否则第一批 issue 会被 Windows 环境问题淹没，烧掉 48h 响应带宽
- 所有常见错误（无密钥、429、网络、模型不存在）给可执行的下一步，不给堆栈
- **验收**：找 2 个朋友盲测安装到首任务，卡点全部记录并修复；**每次盲测记录「首任务成功/失败 + 失败原因」**（见 3.5）

### 3.4 发版与反馈管道（P1）

- issue 模板（bug/feature，bug 模板要求贴 `xio doctor` 输出）
- CHANGELOG 面向用户重写；固定 1–2 周发版节奏
- 明确遥测立场：**不加遥测**（与本地优先承诺一致），用 `xio feedback` 命令引导手动反馈代替

### 3.5 任务成功率内部度量（P1，不进对外叙事）

韧性钩子把用户带进门，但**第二周还在不在，取决于 agent 能不能把任务做对**（模型 + 提示词 + 工具质量）。对外砍掉 eval 叙事 ≠ 内部放弃度量：

- 盲测与 Phase 2 每个真实用户都记同一个二值指标：「首任务成功/失败 + 失败原因」
- 记录表与失败原因分类：[FIRST-TASK-LOG.md](./FIRST-TASK-LOG.md)
- `xio eval` 对外冷冻，但保留内部最小用法做任务质量回归（它是现成的度量工具，不必重造）
- 没有这条，Phase 3 决断时只知道「留存了没有」，不知道「为什么」，退出访谈会变成瞎猜

### 3.6 TUI 丝滑度（P0，丝滑是产品钩子的一部分）

对照 pi（earendil-works/pi-tui：差分渲染 + CSI 2026 同步输出 + 主 buffer 原生滚动）审计后的结论：投影层（reducer/coalescer/分块 buffer）设计健康，问题在最后一公里。

**首要问题——路线漂移**：STATUS.md 宣称默认 Route B（append-to-scrollback，终端原生滚动），但 `run-ink-session.ts` 硬编码 Route A（`alternateScreen: true` 全屏自管视口）——发布路径上每 16ms flush 对全部历史块做 O(n) 行高估算，长会话线性劣化；滚动是 React state 3 行步进 + 估算行高跳动；终端原生滚动/搜索全部不可用。

**P0（本 Phase 必做，两刀）**：
- 消除路线漂移：默认切真正的 Route B（`appendScrollback: true` + `alternateScreen: false`；`<Static>` 分支已存在、key 已稳定）。一刀同时消灭 O(n) 窗口重算、自管滚动手感、行高估算跳动；这也是 pi 的路线。若有理由保留 Route A，则必须改 STATUS——文档与代码二选一对齐，不允许继续文档说 B 代码跑 A
- live 区加行数上限（12–16 行尾部窗口，不只 4000 字符预算）：Ink 每帧重画成本与 live 行数成正比，这是长 thinking 流式期卡顿/闪烁主源

**P1**：
- 定稿尖峰：`codeTokenPattern` 按 lang 缓存（每行现场 `new RegExp` → Map）；长回答可分帧 commit
- 按键路径：`collectSlashCommands` 结果缓存；`@` 文件过滤挪出同步 handler；退格改 `Intl.Segmenter` 真 grapheme（当前码点级会拆坏 emoji ZWJ）
- 绘制层 bench 护栏：用 ink-testing-library 加真实渲染 replay fixture（渲染次数 + 耗时）纳入 `xio bench`——当前 `tui.replay_10k` 是 headless（无 Ink），丝滑度是唯一没有护栏的性能轴，与「bench 回归是 P0」的纪律相悖

**P2（切 Route B 后观察再动）**：
- live 区仍闪烁 → 借 pi 的 CSI 2026 同步输出（Ink 写出外包 `\x1b[?2026h/l`），这是 pi-tui 零闪烁的核心机制，实现成本低

继续遵守 ADR-0002：不引入 pi-tui 依赖，只搬技术思路（mouse-scroll/markdown 已有先例）。主题/外部编辑器/图片粘贴等 pi 社区面功能维持不做（无用户信号）。

**验收**：长会话（>200 块）流式期无可感知卡顿；滚轮/搜索由终端原生完成；绘制 fixture 进 bench 且有基线数字。

**冻结例外**：本 Phase 之外的任何功能想法进 backlog，不进代码。

---

## 四、Phase 2 · 获取前 10–50 个真实用户（第 5–9 周）

写代码在这个阶段是次要工作。

1. **发布材料**：一个 90 秒 demo（长会话韧性钩子：任务中 kill 进程 → resume → rollback）+ 重写后的 README
2. **渠道**（按目标用户匹配度）：
   - linux.do / v2ex（国产模型 BYOK 用户密度高，DeepSeek 支持是钩子）
   - Hacker News「Show HN」、Reddit r/LocalLLaMA、r/commandline（本地优先叙事）
   - GitHub topics + awesome-list PR
   - **投放顺序（决策）**：先中文渠道当低风险试炼场，消化安装卡点与第一波 issue；README/demo 打磨到位后**再**打 HN——Show HN 只有一次机会，用国内渠道反馈给首发去风险
3. **接触即服务**：前 20 个用户逐个跟进（issue/私信），每条抱怨 24h 内回应；抱怨直接生成 Phase 3 的路线图
4. **度量**（手工即可）：安装转化（下载→首任务成功）、每周活跃回访、issue 数

**验收**：≥ 10 个可数的非本人用户在真实仓库跑过任务，且留下了反馈。

---

## 五、Phase 3 · 留存验证与决断（第 9–13 周）

- 路线图 100% 来自 Phase 2 用户反馈，按「阻止使用 > 造成不信任 > 增强钩子」排序
- 每个发版通知给过反馈的用户，形成回路
- **决断线（诚实执行，不许拖延）**：
  - ≥ 4 个用户两周留存 → 产品命题成立，规划下一个 90 天
  - 有用户但零留存 → 钩子错了，用退出访谈换钩子再试一轮
  - 连 10 个试用用户都获取不到 → 命题终止，回作品集收尾（原路线 A 资产仍在）

---

## 六、风险与诚实前提

| 风险 | 应对 |
|------|------|
| 头部竞品（Claude Code/Codex/Cursor）免费额度 + 模型端优势 | 不正面打"更强"；打隐私/BYOK/国产模型/韧性缝隙 |
| 单人带宽：开发 + 支持 + 运营并行 | Phase 1 只有 4 项就是为此；每周固定 ≥ 2 天做非代码工作 |
| ~~AGPL + 商业双许可吓退公司用户~~ | ✅ 已解除（2026-07）：改为 MIT，`LICENSE` / `package.json` / 两份 README 同步，`COMMERCIAL.md` 移除。企业采用不再有授权阻力，也不再需要商业授权谈判 |
| Node 22.6+ 安装门槛 | install.sh 必须兜住 Node 本身（检测 + 引导安装，已列为 3.3 P0 达标项）；若仍是卡点，再评估单文件二进制（SEA/bun），不预做 |
| "自改进"沉没成本诱惑 | 冷冻不是删除；只有当真实用户主动要求时才解冻 |

---

## 七、总检查线

- [x] Phase 0：README/GOAL 收缩完成，实验性面已隐藏（`xio --help` 下 eval/regress/improve/bench 标 Experimental）
- [x] Phase 1 **代码部分完成**（2026-07-26）：
  - [x] 成本显示真实数字 — `src/runtime/pricing.ts` 版本化 price table + `[pricing."<model>"]` 覆盖；footer 与 `xio -p` 显示 `$0.0042` 级数字；未知模型 `~unknown`，部分未计价 `$x+`，永不假 `$0`
  - [x] 危险命令拦截可演示 — `src/runtime/command-risk.ts`：默认模式下 `rm -rf ~` 必确认；工具级 session 批准不覆盖命令级；`full`/`bypass` 放行但告警
  - [x] doctor + issue 模板就绪 — `xio doctor`（Node 优先）+ bug/feature/config 模板（bug 强制贴 doctor 输出）+ `xio feedback`
  - [x] install.sh 兜住 Node — 检测 + 每平台一行命令；`XIO_INSTALL_NODE=1` 经 fnm 自动装
  - [x] 首启不再撞墙 — 无密钥也能进会话并引导 `/connect` + 建议首任务；provider 错误全部给可执行下一步
  - [x] TUI 路线漂移消除（默认 Route B）+ live 行数上限（`LIVE_MAX_LINES=14`）+ **绘制 bench 护栏**（`tui.ink_render` 真 Ink 挂载，基线 wall P50 ~576ms / P95 ~632ms；进 `default-gate.v1.3.0` rendering 组）
  - [x] TUI P1 热路径 — `codeTokenPattern` 按注释风格缓存；slash 命令表按 `host.commandsRevision` 缓存；`@` 文件索引 WeakMap 缓存 + 渲染/按键去重；退格改 `Intl.Segmenter` 真 grapheme
  - [ ] **盲测 5 分钟首任务通过（含首任务成功率记录）— 未做，需要真人**：记录表见 [FIRST-TASK-LOG.md](./FIRST-TASK-LOG.md)
- [ ] Phase 2：demo 发布；≥ 3 渠道投放；≥ 10 个真实用户
- [ ] Phase 3：留存数字出炉，按决断线执行，无论结果

> **下一步不是写代码**：Phase 1 剩下的唯一一项（两轮盲测）和整个 Phase 2 都需要真人。
> 按计划纪律，在拿到第一批盲测卡点之前不应再向 Phase 1 加功能。
