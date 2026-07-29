# 设计：effort 档位 · ultra 需求拆分 · xcf 配置工具

> 状态：设计草案（2026-07-27）。基线 `7b2ae38`。
> 关联：[REVIEW-2026-07-27.md](./REVIEW-2026-07-27.md)（本设计解决其中的 D7-Trellis、B6-国产 provider 两项）· [ROUTE-B-PRODUCT-PLAN.md](./ROUTE-B-PRODUCT-PLAN.md)
> 已定决策：① 配置工具做**独立 npm 包 `npx xcf`**；② ultra 拆分对 Trellis **可降级**。

---

## 0 · 先说结论：三件事里有两件已经有一半

测绘后的事实，先纠正一个前提：

| 设想 | 现状 |
|------|------|
| 「xiocode 可以设置 effort level」 | **已经有了。** 8 级阶梯 `off\|minimal\|low\|medium\|high\|xhigh\|max\|ultra`，配置键 `[general].default_thinking_level`，`/thinking` 与 `/effort` 两个 slash 命令，Tab 循环，状态栏 `think:<level>`，改档写回 config.toml |
| 「只有 ultra 模式下需求才会被拆分」 | **判据已经有了，拆分动作是空的。** ultra 时注入 `ULTRA_PARALLEL_PLAN_ADDENDUM`，用自然语言告诉模型「该拆分了」；但全仓没有任何代码路径会**生成**或**触发**并行计划——产物由模型手写 JSON 塞进 `parallel_plan_json`，xiocode 只做 schema 校验 + 落盘 |
| 「进入我们之前讨论的流程」 | **链路是通的，但只在作者本机能跑。** `parallel_dispatch` → `python3 .trellis/scripts/task.py`，而那套脚本**未被任何 git 跟踪、不在任何公开仓库** |

所以真正要做的是三件：**把拆分动作补成代码**、**让它在没有 Trellis 时也能跑**、**让配置与分发有个入口**。

---

## 1 · effort 档位：不新增枚举，只把副作用显式化

### 1.1 现状精确描述

```
[general] default_thinking_level = "high"
   ↓ src/runtime/session.ts:769-773
ExtensionHost.#thinkingLevel（会话态）
   ↓ src/runtime/agent-loop.ts:700
request.thinkingLevel
   ↓ src/runtime/thinking.ts:78-98（三张 wire 映射表）
DeepSeek: reasoning_effort = high|max    （ultra → "max"）
OpenAI:   reasoning_effort = low|…|xhigh （ultra → "xhigh"）
Anthropic: thinking.budget_tokens        （ultra → 128000）
```

**`ultra` 从不原样发给任何 provider**，它是纯客户端档位。这个「产品档位 ≠ wire 档位」的做法是对的，保留。

`ultra` 当前额外承担三个副作用（`src/runtime/session.ts:352-356`、`src/runtime/plan/register.ts:39-45`）：

1. 自动开启 multi-explore
2. 抬高 explore deep lane 上限
3. 注入 parallel-plan addendum（**仅当检测到 Trellis**）

### 1.2 问题

`ultra` 同时是「推理预算档位」和「行为模式开关」，两个正交的东西挤在一个枚举里。用户从 `/effort` 的帮助里看不出切到 ultra 会额外触发拆分与并发子代理——这是**没有知情同意的行为变更**，和项目自己在 `/bypass` 上犯的错（评审 C6）同一类。

### 1.3 方案：新增 `[effort]` section，不动 thinking 枚举

```toml
[effort]
# 需求分解在哪个档位触发：ultra（默认）| always | off
decompose = "ultra"
# 分解后如何执行：auto（有 Trellis 走并行，否则串行）| parallel | serial | ask
execute = "auto"
# 分解前是否询问用户确认计划
confirm_plan = true
```

- 解析样板照抄 `parseAgent`（`src/cli/config-parser.ts:683-687`），五步：类型 → 默认值 → `parseEffort` → `parseXioConfig` 分发（:446-465）→ `toRuntimeConfig` 透传（:494-516）
- 默认值与当前行为**完全一致**（`decompose="ultra"`），不改变既有用户体验
- 状态栏在会触发拆分时显示 `think:ultra ⚡split`，`/effort` 的帮助文本补一行说明副作用
- `default-config.ts` 模板补上带注释的 `# [effort]` 块——顺带把评审 D6 里「`[skills]`/`[hooks]`/`[agents_md]` 连注释都没有」一并补掉

**明确不做**：不新增第二套 level 枚举。`XioThinkingLevel`（`config-parser.ts:13`）与 `ThinkingLevel`（`runtime/types.ts:1`）已经是字面重复的第二真相源，再加一套会变成三套。

---

## 2 · ultra 需求拆分：把空洞补成代码

### 2.1 目标链路

```
用户一句需求（ultra 档）
  │
  ├─[1] 触发判据（代码，非 prompt）          ← 新增
  ├─[2] 分解器：只读子代理产出 ParallelPlanV1  ← 新增
  ├─[3] 校验 validateParallelPlan            ← 已有，需补一条规则
  ├─[4] 落盘 writeParallelPlan               ← 已有，直接复用
  ├─[5] 计划确认门（给人看的 planSummary）     ← 已有 gate1，前移
  └─[6] 执行器分流                            ← 新增分流 + 新增串行执行器
        ├─ 有 Trellis + git + ask → parallel_dispatch（已有）
        └─ 否则 → 串行执行器（新增）
```

### 2.2 [1] 触发判据：从 prompt 挪进代码

**现状**：唯一判据是 `ULTRA_PARALLEL_PLAN_ADDENDUM` 里那句自然语言 —— "multi-file / multi-deliverable (not a trivial single-file fix)"。模型可能永远不触发，也可能对改一行注释触发。

**方案**：在 `src/runtime/plan/register.ts:33-52` 的 `before_agent_start` 钩子里（这是目前唯一同时拿得到 thinkingLevel、Trellis presence 与 system prompt 的地方）加一个显式判据：

```
shouldDecompose =
     effort.decompose === "always"
  || (effort.decompose === "ultra" && host.getThinkingLevel() === "ultra")
```

叠加两个已有信号做「值不值得拆」：
- 现有的 prompt 分类器（simple vs code，`CONTEXT.md:52`）——非 code 类直接不拆
- `src/runtime/explore/scale.ts` 的工作区规模分档——tiny 工作区不拆

**注意坑**：`register.ts:31` 的 `detectTrellis` 是**注册时快照**，会话中途 init 出 `.trellis/` 不会被感知，而 `runParallelDispatch` 每次都重新探测，会出现「prompt 说不可用但 dispatch 其实能跑」。分解器要实时探测，不能用快照。

### 2.3 [2] 分解器：复用 explore 子代理基建

`ExploreOrchestrator` 已经具备「派只读子代理 + 并发上限 + 预算」的全部能力。分解器是它的一个特化用途：

- **工具面**：只给 `read` / `grep` / `glob`。**绝不给 bash** —— explore 子代理跑在全新 ExtensionHost 上、没有任何权限闸（评审 C11），给 bash 等于开一条无门控 exec 通道
- **输出**：结构化 `ParallelPlanV1` 对象，不是自由文本。走 `plan-tool.ts:164` 那条**已经通但未声明 schema** 的 `params.parallel_plan` 对象入口（需补 `Type.Object` 声明才能让模型也用）
- **提示词**：把 `ULTRA_PARALLEL_PLAN_ADDENDUM` 的五条指令从「给主模型的建议」改成「给分解子代理的任务书」

### 2.4 [3] 补一条校验：write_scope 重叠

**这是一个确定的 bug，零成本可修。**

Python 侧 `common/parallel_plan.py:46-101` 的校验顺序比 TS 多最后一道 **`scope_conflicts`**：无依赖边的兄弟之间 `write_scope` 不得重叠。TS 侧 `validateParallelPlan`（`parallel-plan.ts:58-148`）只做到 Kahn 环检测就停了。

后果：**xiocode 判定合法的 plan，会被 `plan-import` 拒收**——用户看到的是「计划做好了，派发时报错」。

修法：在 `parallel-plan.ts` 的 Kahn 检测之后追加同一条规则。这也让串行降级路径有能力判断哪些 child 真的能并行。

### 2.5 [6] 串行降级执行器（「可降级」决策的落点）

这是本设计的核心新增件，也是让 ultra **对外部用户可用**的唯一办法。

```
输入：已校验的 ParallelPlanV1
拓扑排序 → 逐个 child：
  ├─ 把 child.title + description + write_scope 组装成子任务 prompt
  ├─ 在当前会话内执行（不建 worktree、不 spawn 进程、不碰 Trellis）
  ├─ 完成后跑 child.verify（若有）——走 bash 工具，因此**受 command-risk 拦截层保护**
  └─ 更新 tasks.json 状态
```

**顺带建成 `tasks.json` ↔ `parallel-plan.json` 的桥**（现在完全不存在）：
`PlanTask.id ← child.slug`、`title ← title`、`note ← write_scope 摘要`。这样 TUI 的 tasklist widget 能显示拆分进度——用户第一次能**看见** ultra 干了什么。

**必须先改的既有不变量**：`enforceSingleInProgress`（`plan-tool.ts:300-311`）会把其它 `in_progress` 静默降回 `pending`。串行模式下无碍，但并行模式下与语义直接冲突，桥接前要先放开。

**串行 vs 并行的诚实边界**（要写进用户可见文案）：

| | 并行（Trellis） | 串行（降级） |
|---|---|---|
| 隔离 | 每个 child 独立 worktree | 无隔离，直接改当前目录 |
| write_scope | Trellis 侧**强制** | 仅用于排序与提示，**不强制** |
| 合入 | integrate + 两道 ask 门 | 无合入步骤（本来就在主树） |
| 速度 | 波次并发 | 线性 |

### 2.6 失败分流需要结构化返回

`ParallelDispatchResult` 现在只有 `{ok, message}`（`parallel-dispatch.ts:39-42`），上游无法程序化区分「Trellis 缺失」「用户拒绝」「校验失败」「合并冲突」。**没有这个，「自动回退串行」写不出来。**

新增判别字段，所有失败点（`:163/175/179/197/208/227/238/251/261`）打标：

```
reason: "no-trellis" | "no-git" | "no-ask" | "plan-invalid"
      | "declined-dispatch" | "declined-merge" | "import-failed"
      | "dispatch-failed" | "verify-red" | "timeout"
```

顺带修一个已知不对称：**gate2 拒绝返回 `ok:true`**（`:246-254`），gate1 拒绝返回 `ok:false`（`:193-200`）。

### 2.7 安全面必须同步的两处

1. **`command-risk` 正则**（`command-risk.ts:111-119`）只拦带 `--yes` 的三个子命令。新增任何 spawn 型 `task.py` 子命令必须同步扩这条正则，否则模型可用 bash 绕过两道 ask 门。
2. **`child.verify` 以用户权限跑 shell**，且只做 `typeof string` 校验、不经 `command-risk`。它必须在 `planSummary`（`parallel-dispatch.ts:146-156`）里对授权者完整可见——函数注释已把这写成硬要求。串行执行器跑 verify 时应改走 bash 工具，从而获得拦截层保护。

---

## 3 · xcf：独立配置工具

### 3.1 定位

对标 zcf（`npx zcf` 交互菜单，一键给 Claude Code/Codex 配 workflows + API + MCP）。**xcf 的差异化在于它同时配两样东西：xiocode 与 Trellis**——这正是「桥接两个工具」的合理定位，也是独立成包的理由。

```bash
npx xcf              # 交互菜单
npx xcf i            # 完整初始化：装 xiocode + provider + MCP + Trellis
npx xcf i -s -p deepseek -k sk-xxx    # 非交互，对标 zcf 的 -s -p -k
npx xcf trellis      # 只装/更新 Trellis
npx xcf doctor       # 转发 xio doctor --json + Trellis 自检
```

### 3.2 价值区：17 个没有任何入口的配置 section

xiocode 目前只有三类配置有交互入口（`/connect`、`/model`、`/thinking`）。**其余 17 个 section 只能手写 TOML**，而且其中 `[agents_md]` `[skills]` `[hooks]` `[verify]` `[extensions]` 连默认模板注释都没有：

`worktree` · `explore` · `mcp` + `mcp.servers` · `skills` · `hooks` · `agents_md` · `permissions` · `tools` · `harness` · `agent` · `context` · `pricing` · `improve` · `regress` · `retrospective` · `verify` · `extensions`

这是 xcf 的主战场。

### 3.3 xiocode 侧要补的三个小东西（各自独立有价值）

| # | 改动 | 为什么值得单独做 |
|---|------|------------------|
| X1 | `xio connect --preset <id> --key <k> [--model] [--base-url]` 非交互形态 | `persistConnect`（`connect-commands.ts:207-248`）已把「写 credentials + 改 TOML + 注册 provider」封装好，只是被 `InteractiveIO` 绑死。抽出来即可同时服务 CLI、脚本、CI 与 xcf——**不必让外部工具重复实现 TOML 语义** |
| X2 | `xio doctor --json` | `CheckRow`（`doctor-cli.ts:28-34`）已经是结构化的 `{status,name,detail,fix}`。加一个分支即可让工具消费，而不是 grep emoji。顺带修评审 B4（doctor 无视 config.toml 的 providers） |
| X3 | **`PROVIDER_PRESETS` 改为「内建 ∪ `~/.xiocode/providers.json`」** | **最关键的一条。** 现在 6 条 preset 硬编码在 `provider-catalog.ts:13-73`，每加一个国产 provider 都要发一版 xiocode。改成可外部注入后，xcf 能自带 provider 目录并随工具更新——**直接解决评审 B6「国产模型一等公民只覆盖 DeepSeek 一家」**。消费点只有 `provider-catalog.ts:75-87` 三个函数 |

X3 单独说明：对 OpenAI 兼容网关，**只改这一处**就能让 `/connect`、`xio models`、`xio doctor` 三个面同时识别（`discoverModels` 对非 anthropic/google 统一打 `${baseUrl}/models`）。可选再补 `env-setup.ts:10` 的 env 名映射与 `pricing.ts:22` 的价目行（不补则成本显示 `~unknown`）。

### 3.4 xcf 怎么写配置：直接写文件，不 import xiocode

**硬约束**：xiocode 不发布任何可 import 的模块——`package.json` 无 `main`/`exports`，`files` 只含 `bin`+`dist`，dist 由 esbuild 以 `entry.ts` 为唯一入口打包。所以 `import {saveProviderCredential} from '@xioshark/xiocode'` 走不通。

xcf 的落地方式：

1. **provider/key 走 X1 的 `xio connect`**（spawn 子进程）——避免重复实现 TOML 语义与 credentials 不变量
2. **其余 17 个 section 用真正的 TOML 库直接写**——不要模仿 `config-mutate.ts` 的正则做法（它是纯字符串正则、对多行数组/行内表不安全，且 `upsertProviderBlock` 会**整段重写** `[providers.x]`，丢掉用户手写的 `context_window`/`headers`/注释）
3. **写完必须验证**：spawn `xio doctor --json`。配置解析是 fail-hard 的（越界/类型错直接 throw 导致启动失败），写坏了必须当场发现

### 3.5 xcf 必须遵守的不变量

| 不变量 | 依据 |
|--------|------|
| **config.toml 里永不写 API key**，只写 `api_key_env` 名字 | `config-mutate.ts:1-4`、`default-config.ts:3` |
| credentials.json 必须 0600、目录 0700 | `credentials.ts:50,64-65` |
| credentials.json 是无锁 read-modify-write，**不得与运行中的会话并发写** | `credentials.ts:51-64` |
| `XIO_HOME` 与 `XIO_CONFIG` 语义不对称：credentials/trust/runs 走前者，config.toml 只认后者。做沙箱要**两个都设** | `ensure-config.ts:16` vs `credentials.ts:28` |
| **不得写 `~/.xiocode/runtime-config.json`** —— 它是每次启动从 config.toml 派生的中间产物，写了下次启动就被覆盖 | `launch.ts:96` |
| 安全语义开关默认保守，不顺手打开 | `[permissions].allow_high_risk`、`[trust].mode`、`[tools].require_read_before_edit`、`[worktree].enabled` |
| MCP 写哪儿是个产品决策：`.mcp.json`（与 Claude Code 共享）vs `config.toml [mcp.servers]`（xio 私有、优先级最高） | `mcp.ts:243-247` |
| 往项目目录写配置后，用户仍需在首次会话通过 trust 询问才生效 | `xio-extension.ts:62-63` |

---

## 4 · 阻塞项：Trellis 现在不在任何公开仓库

**这是 xcf 的 Trellis 部分与 ultra 并行路径的共同前置条件，必须先解决。**

测绘实测：

- 那套脚本只存在于 `/Users/xioshark/Desktop/career/.trellis/scripts`，且 **`git ls-files .trellis` 返回 0 条**——整个目录未被版本化
- 公开的 `Xio-Shark/Trellis` fork（最后提交 2026-07-16）里 `task.py` 对 `plan-import|dispatch-ready|integrate` 命中 **0 次**，没有 `multi_agent/` 目录
- 官方 npm 包 `@mindfoldhq/trellis`（0.6.9）也没有这些文件，连 `multi_agent/` 和 `worktree.yaml` 都已不再下发

需要公开的 5 个手写件：

```
common/plan_import.py      # plan-import 实现
common/parallel_plan.py    # schema 校验 / 拓扑 / write_scope / ready 判定
common/worktree_ops.py     # 自 start.py 抽取的 worktree 生命周期
multi_agent/dispatch.py    # 波次派发 / 依赖分支合并 / verify / flock
multi_agent/integrate.py   # 写域按 child 独有提交统计 / 复用污染检查
common/cli_adapter.py      # 其中的 xio 平台分支（:371-380）
```

**在这之前，ultra 的并行路径对外部用户等于不存在**——这也正是评审里「464 行 Trellis 派发只有作者本机能用，却把 Trellis 概念写进每个用户的 system prompt」那条的根因。串行降级执行器（§2.5）是这个阻塞项的**解耦方案**：它让 ultra 在 Trellis 公开之前就对外可用。

### 4.1 handoff 契约的两个脆弱点（公开时一并修）

1. **`plan-import` 的 stdout 最后一行是隐式契约**：`parentRel = importResult.stdoutLines.at(-1)`（`parallel-dispatch.ts:211`）。task.py 若在最后多打一行日志，后续三步全部作用在错误的任务目录上。只有注释保护，没有格式校验。→ 建议改成 `--json` 输出或加前缀标记行。
2. **进度转发靠正则白名单**：`FORWARD_PATTERN`（`:47-48`）决定哪些输出行会 notify 到 UI，tail 只保留最后 60 行。task.py 措辞变化会导致进度静默。

---

## 5 · 建议顺序

分四批，每批都能独立交付价值：

**批 0（先于一切，来自评审）**：发版 —— 现在 npm 上的 1.1.1 连 doctor 和成本显示都没有。本设计的任何东西都必须先有一个能装到的基线。

**批 1（小、独立、各自有价值）**
- X3：`PROVIDER_PRESETS` 可外部注入 → 解决国产模型宽度
- X2：`xio doctor --json` + doctor 读 config.toml 的 providers
- X1：`xio connect` 非交互形态
- §2.4：补 `write_scope` 重叠校验（确定性 bug，零成本）
- §2.6：`ParallelDispatchResult` 结构化 reason

**批 2（ultra 拆分，不依赖 Trellis）**
- §1.3：`[effort]` section
- §2.2：触发判据进代码
- §2.3：分解器子代理
- §2.5：串行降级执行器 + tasks.json 桥

**批 3（xcf）**
- 独立包骨架 + 交互菜单 + 非交互参数
- 17 个 section 的配置面
- 转发 `xio connect` / `xio doctor --json`

**批 4（Trellis 公开，解阻塞）**
- 5 个手写件推到公开 fork
- 修 §4.1 的两个契约脆弱点
- xcf 接管 Trellis 安装 → ultra 并行路径对外可用

---

## 6 · 与评审结论的张力（如实记录）

[REVIEW-2026-07-27.md](./REVIEW-2026-07-27.md) 的结论是「瓶颈不在代码在分发，停止写代码去做分发」。本设计新增的面不小，与那条结论有张力。三点说明：

1. **xcf 本身是分发动作**：独立 npm 包 = 一个额外的获客入口，这是选它而非内置 `xio setup` 的主要理由。
2. **批 1 的五项都在修评审里点名的缺陷**，不是新功能。
3. **批 2/3/4 是真的加面**。按计划书自己的纪律（「用户抱怨是唯一路线图」），它们应当排在批 0 与两轮盲测之后——除非把 xcf 当作获客手段前置，那就要明确这是一次**有意的纪律例外**，而不是默认路径。
