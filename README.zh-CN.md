# XioCode

> 本地优先的终端 AI 编程智能体 —— 读代码、改文件、跑命令，合入权始终在你手里。

**English → [README.md](./README.md)**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-22.6%2B-green.svg)](https://nodejs.org/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.1.0-informational.svg)](./package.json)

---

## XioCode 是什么？

```
  ┌─────────────────────────────────────────────┐
  │               你的终端                        │
  │                                             │
  │  $ xio "帮我加一个登录页面"                    │
  │                                             │
  │  ┌─────────────────────────────────────┐    │
  │  │  XioCode 会：                        │    │
  │  │  → 读取你的项目                       │    │
  │  │  → 理解代码结构                       │    │
  │  │  → 修改文件                           │    │
  │  │  → 跑命令                             │    │
  │  │  → 展示改动，等你确认                   │    │
  │  └─────────────────────────────────────┘    │
  │                                             │
  │  结果：项目已经改好了                         │
  └─────────────────────────────────────────────┘
```

XioCode 是带**自有 TypeScript runtime** 的本地 AI 编程智能体——直接在你电脑的项目目录里工作，没有云端 agent 服务，代码不出门。

**四个产品赌注：**

| 赌注 | 什么意思 |
|------|---------|
| **快** | early-boot 首帧、流式 TUI、discovery / schema 缓存 |
| **不跑偏** | plan / todo / 中途 steer / follow-up / 工具结果完整进上下文 |
| **零门槛 cwd** | 默认当前目录；**不强制 git**；worktree **默认关** |
| **合入在你** | 可选 worktree + MergeGate；自改进从不自动合入 |

---

## 环境要求

- **Node.js 22.6+**（需 `--experimental-strip-types`）
- 一个模型的 API Key（DeepSeek、OpenAI、Anthropic 等）

---

## 快速安装

```bash
# 一行搞定（推荐）
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
```

或者用 npm：

```bash
npm install -g github:Xio-Shark/xiocode
```

装完就有 `xio` 和 `xiocode` 命令。

---

## 第一次使用

```bash
cd 你的项目
export DEEPSEEK_API_KEY=sk-xxxxx   # 换成你的 key
xio
```

进入界面后也可以输入 `/connect` 本地保存密钥，不必写环境变量。

```
  xio
   │
   ▼
  ┌──────────────────────────────┐
  │  欢迎！                       │
  │                              │
  │  输入 /connect 配置密钥       │
  │  或者直接告诉我要做什么        │
  │                              │
  │  > "帮我给支付模块加上错误处理"  │
  └──────────────────────────────┘
```

---

## 工作流程

```
你输入任务                       XioCode 开始工作
     │                                │
     ▼                                ▼
┌──────────────┐             ┌──────────────────────┐
│ "帮我加一个   │             │ 1. 读你的代码        │
│  API 接口"   │ ──────────► │ 2. 规划怎么改        │
└──────────────┘             │ 3. 修改文件           │
                             │ 4. 跑命令验证         │
                             └──────────┬───────────┘
                                        │
                                        ▼
                             ┌──────────────────────┐
                             │ 展示改动，等你确认     │
                             │                      │
                             │ ┌────────────────┐   │
                             │ │ + 新接口       │   │
                             │ │ + 参数校验     │   │
                             │ └────────────────┘   │
                             │                      │
                             │ ✅ 确认合并          │
                             │ ❌ 拒绝修改          │
                             └──────────────────────┘
```

**默认路径：** 直接在启动目录改文件。不需要 git，也没有沙箱。

**更安全（可选）：** 在 `~/.xiocode/config.toml` 里设 `[worktree] enabled = true`。XioCode 会在独立 git worktree 里工作，你执行 `/merge` 后才合回主树。

---

## 常用命令

| 命令 | 作用 |
|------|------|
| `xio` | 交互模式 |
| `xio "帮我做件事"` | 一次性任务（非交互） |
| `xio init` | 生成默认配置 |
| `xio models` | 查看可用模型 |
| `xio resume` | 恢复上次会话 |
| `xio improve` | 自改进外环（worktree + 校验 + 合入询问） |
| `xio eval` | 可信能力基线（preflight / smoke / compare） |
| `xio regress` | 私有回归 capture / preflight / compare |
| `xio bench` | 本地性能夹具（P50 / P95） |

交互界面里：

| 命令 | 作用 |
|------|------|
| `/connect` | 配置 API Key |
| `/model` | 切换模型 |
| `/merge` | 查看并确认合并（worktree 模式） |
| `/rollback` | 撤回会话或本轮文件改动 |
| `/compact` | 压缩对话上下文 |
| `/help` | 查看所有命令 |

回合进行中：Enter / `!text` 软转向；`>>text` 把 follow-up 排到自然回合结束。输入 `@路径` 可引用文件。

---

## 开箱能力

- 自有 agent loop + 工具：`read` / `write` / `edit` / `bash` / `grep` / `glob`
- Ink TUI：流式回答、工具行、markdown 定稿、usage footer
- 目标仓 `CLAUDE.md` / skills / hooks / MCP（tools-first）
- 可选 worktree 沙箱 + MergeGate；会话 / 回合 rollback
- 本地证据目录 `~/.xiocode/` — runs、sessions、evals、regress

更完整的产品真相：[docs/GOAL.md](./docs/GOAL.md) · 交付快照：[docs/STATUS.md](./docs/STATUS.md) · 近期：[ROADMAP.md](./ROADMAP.md)

---

## 本地数据存储

```
~/.xiocode/
├── config.toml          # 配置（不含密钥）
├── credentials.json     # API 密钥（永远不要提交到 git！）
├── trust.json           # 项目信任决策
├── runs/                # 运行记录
├── sessions/            # 对话记录（可恢复）
├── worktrees/           # git 工作副本（可选）
├── evals/               # 可信评测报告
└── regressions/         # 私有回归 case
```

所有数据都在**你的电脑上**，不上传云端。

---

## 许可证

**双授权：AGPL-3.0 OR Commercial License**

| 使用场景 | 许可 |
|----------|------|
| 个人学习、研究、爱好 | ✅ [AGPL-3.0](./LICENSE)（免费） |
| 开源项目 | ✅ [AGPL-3.0](./LICENSE)（免费） |
| 商业 / 闭源产品 | ❌ 需购买 [商业授权](./COMMERCIAL.md) |
| SaaS / 云服务 | ❌ 需购买 [商业授权](./COMMERCIAL.md) |

商业授权请联系：**xioshark.0127@gmail.com**

---

## 问题和反馈

- Issues：https://github.com/Xio-Shark/xiocode/issues
- 邮箱：xioshark.0127@gmail.com
