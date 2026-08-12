# XioCode

> 住在终端里的编程智能体：怎么崩都不丢现场，密钥自己带，合不合入永远你说了算。编排与工具在本地；只有你选中发给模型的上下文会到达你配置的服务商。

**English → [README.md](./README.md)**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-22.6%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.2.1-informational.svg)](./package.json)
[![CI](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml/badge.svg)](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml)

---

## XioCode 是什么？

```
  ┌────────────────────────────────────┐
  │              你的终端              │
  │                                    │
  │  $ xio "帮我加一个登录页面"        │
  │                                    │
  │  XioCode 会：                      │
  │    → 读取你的项目                  │
  │    → 理解代码结构                  │
  │    → 修改文件                      │
  │    → 跑命令                        │
  │    → 每一处改动都摆在你眼前        │
  │                                    │
  │  结果：项目已经改好了              │
  └────────────────────────────────────┘
```

XioCode 的编排、工具执行、会话存储和文件修改在本机运行。XioCode 不运营请求中转服务，也不运行自有的产品使用遥测服务。

为完成请求，XioCode 会把当前模型请求直接发送到你配置的模型服务端点。请求可能包含你的提示、系统与上下文指令、工具定义，以及已经加入对话的文件内容或工具结果。相关数据由你配置的服务商按其条款处理。

```
  ┌────────────────────────────────────┐
  │              你的电脑              │
  │                                    │
  │  你的代码                          │
  │    │ 读取                          │
  │    ▼                               │
  │  XioCode（本地运行）               │
  │    │ 修改                          │
  │    ▼                               │
  │  你的代码——已经改好了              │
  └───────┬────────────────────────────┘
          │  模型请求上下文
          │  （可能包含文件内容和工具结果）
          ▼
  ┌────────────────────────────────────┐
  │          模型（云端）              │
  │  DeepSeek · OpenAI ·               │
  │  Anthropic · Gemini ...            │
  │                                    │
  │  接收本次模型调用所选择的          │
  │  请求上下文                        │
  └────────────────────────────────────┘
```

**用它的三个理由：**

1. **现场永远都在。** 每动一步之前，XioCode 先把这一步记进日志。任务跑到一半 kill 掉进程、终端没了、笔记本没电了：`xio resume` 原地打开会话，对话和任务状态一样不少。开了 worktree 模式，`/rollback` 还能把文件改动整个撤掉。

```
  "重构支付模块" ──► 第 1 步 ──► 第 2 步 ──► crash!
                                                  │
                                                  ▼
                  $ xio resume                     
                  从断点原地继续                   
                  什么都不会丢                     
```

2. **本地运行，自带服务商。** 可恢复会话和运行记录默认存放在你的电脑上。模型请求会发往你配置的服务端点；XioCode 不运营请求中转或自有产品遥测服务。你手上任何一家的 key 都能用：DeepSeek、OpenAI、Anthropic、OpenRouter、Google Gemini，或者任意兼容 OpenAI 接口的服务。

3. **合入权在你。** 默认模式下它直接改你的目录，每处改动实时可见，危险命令会先停下来问你。打开 worktree 模式，它就在一份独立的 git 副本里干活——你不敲 `/merge`，主目录一个字符都不会变。

```bash
$ xio "重构支付模块"
# ... agent 干活中 ... 你按了 Ctrl-C / 终端崩了 / 笔记本没电了
$ xio resume        # 从断点原地继续
> /rollback         # worktree 模式：把这个会话的文件改动整个撤掉
```

---

## 环境要求

- **Node.js 22.6+**（需 `--experimental-strip-types`）—— `install.sh` 会自动检测并告诉你怎么升级
- 任意一家支持的模型密钥：DeepSeek、OpenAI、Anthropic、OpenRouter、Google Gemini，或自定义 OpenAI 兼容网关

**支持平台：**

| 平台 | 状态 |
|------|------|
| macOS | ✅ 支持 |
| Linux | ✅ 支持 |
| Windows | ⚠️ 未测试 —— 请用 [WSL](https://learn.microsoft.com/windows/wsl/) |

---

## 快速安装

```bash
# 一行搞定（推荐）— 从 npm 安装 @xioshark/xiocode
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
```

锁定版本：

```bash
export XIO_INSTALL_VERSION=1.2.1
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
```

或者直接用 npm：

```bash
npm install -g @xioshark/xiocode
```

装完就有 `xio` 和 `xiocode` 命令。

---

## 第一次使用

```bash
cd 你的项目
export DEEPSEEK_API_KEY=sk-xxxxx   # 或者进去后用 /connect 配置
xio
```

还没有 key？直接启动也行——会话照常打开，界面会引导你用 `/connect` 把密钥存在本地，之后再也不用碰环境变量。

```
  xio
   │
   ▼
  ┌──────────────────────────────────┐
  │  欢迎！                          │
  │                                  │
  │  输入 /connect 配置密钥          │
  │  或者直接告诉我要做什么          │
  │                                  │
  │  > "帮我给支付模块加上           │
  │      错误处理"                   │
  └──────────────────────────────────┘
```

---

## 工作流程

```
你输入任务                       XioCode 开始工作
     │                              │
     ▼                              ▼
┌──────────────┐             ┌──────────────────────┐
│"帮我加一个   │             │1. 读你的代码         │
│ API 接口"    │             │2. 规划怎么改         │
└──────────────┘             │3. 修改文件           │
                             │4. 跑命令验证         │
                             └──────────────┬───────┘
                                         │
                                         ▼
                             ┌──────────────────────┐
                             │你始终握着方向盘      │
                             │                      │
                             │· 每处改动、每条命令  │
                             │  都实时展示          │
                             │· 危险命令先停下问你  │
                             │· worktree 模式多一道 │
                             │  /merge 关口         │
                             └──────────────────────┘
```

**隔离多少，你来选：**

```
  直接模式（默认）                  worktree 模式（可选）
  ┌────────────────────┐            ┌──────────────────────┐
  │  你的项目          │            │  你的项目            │
  │  agent 直接改      │            │  ▲                   │
  │  改动即时生效      │            │  │ /merge — 你说了   │
  │                    │            │  │ 才算数            │
  └────────────────────┘            └──────────────────────┘
```

1. **直接模式（默认）：** 在你启动的目录里直接干活。不要求 git——刚 `git init` 的空仓库也能直接用。
2. **worktree 模式（可选）：** 在 `~/.xiocode/config.toml` 里设 `[worktree] enabled = true`。XioCode 在独立的 git worktree 里工作，你敲 `/merge` 改动才进主树。这个模式同时解锁 `/rollback`。
3. **容器：** 规划中——有需要请告诉我们。

---

## 常用命令

| 命令 | 作用 |
|------|------|
| `xio` | 交互模式 |
| `xio "帮我做件事"` | 一次性任务，等同于 `xio -p "..."` |
| `xio init` | 生成默认配置 |
| `xio models` | 查看可用模型 |
| `xio resume` | 恢复上次会话 |
| `xio doctor` | 一键自检：Node 版本 / 配置 / 密钥 / provider 连通性 |
| `xio feedback` | 反馈 bug 或提需求（`--bug`、`--feature`） |

交互界面里：

| 命令 | 作用 |
|------|------|
| `/connect` | 配置 API Key |
| `/model` | 切换模型 |
| `/merge` | 查看并确认合并（worktree 模式） |
| `/rollback` | 撤回会话或本轮文件改动（worktree 模式） |
| `/compact` | 压缩对话上下文 |
| `/help` | 打开快捷键面板（也可以直接按 `?`） |

输入 `/` 浏览全部命令，`@路径` 把文件带进对话，空输入框按 `?` 查看完整键位表。

回合进行中：按 Enter 或输入 `!text` 随时给 agent 转向；`>>text` 把话排到本轮自然结束后再说。`Esc` 取消本轮，正在写的草稿会留着。空闲时 `Ctrl+C` 先清空草稿，输入框已空时再按一次才退出。

---

## 开箱能力

- 自带 agent 和全套工具：`read` / `write` / `edit` / `bash` / `grep` / `glob`
- 终端界面：回答边生成边显示、工具实时输出、markdown 渲染、按真实美元计的费用统计
- 崩溃安全的会话：每一步都记日志、打检查点，`xio resume` 随时接着干，worktree 模式下 `/rollback` 还能干净地整体撤回
- 读取目标仓库的 `CLAUDE.md`、skills、hooks 和 MCP 服务
- 可选 worktree 隔离 + 显式 `/merge` 关口
- 默认状态存放在本地 `~/.xiocode/`

产品目标：[docs/GOAL.md](./docs/GOAL.md) · 交付快照：[docs/STATUS.md](./docs/STATUS.md) · 近期：[ROADMAP.md](./ROADMAP.md)

---

## 本地状态

```
~/.xiocode/
├── config.toml          # 配置（不含密钥）
├── credentials.json     # API 密钥（永远不要提交到 git！）
├── trust.json           # 项目信任决策
├── runs/                # 运行记录
├── sessions/            # 对话记录（可恢复）
└── worktrees/           # git 工作副本（可选）
```

XioCode 默认把运行状态存放在 `~/.xiocode/`；`XIO_*` 环境变量和配置项可以改到其他位置。这些文件可能包含 API 密钥、提示、代码片段、命令、工具输出、你配置的请求头和项目信任决策，应按敏感数据保护。

本地存储不等于完全离线：

- **模型服务商：** 每次模型调用都会把请求上下文发送到你配置的服务端点；当文件内容或工具结果进入对话时，它们也可能在请求中。
- **更新检查：** 普通 agent 启动时，约每 24 小时缓存周期可能向 npm 查询一次 XioCode 最新版本。设置 `XIO_DISABLE_UPDATE_CHECK=1` 可关闭。
- **MCP 与 hooks：** 远程 MCP 服务会收到 MCP 请求和工具参数；stdio MCP 与 hooks 会运行你配置的命令，这些命令可能自行联网。
- **显式检查：** `/connect`、`xio models` 和 `xio doctor` 可能访问已配置的服务商端点；`xio models --catalog-only` 和 `xio doctor --offline` 是对应的无网络模式。

XioCode 不向 XioCode 自营服务发送产品使用分析数据。这不代表模型服务商流量、配置的 MCP/hooks 或上述 npm 更新检查被关闭。

---

## 许可证

**[MIT](./LICENSE)** —— 想怎么用就怎么用。

公司内部用、在闭源代码库上用、fork、改、打包进闭源产品分发、拿去做付费服务，全都可以。没有 copyleft，没有开源义务，也没有商业授权需要买。唯一的条件是：分发源码的实质副本时带上版权声明。

你**用** XioCode 写出来的代码永远是你的。

---

## 问题和反馈

`xio feedback` 只会在浏览器中打开 GitHub 页面；XioCode 不会自动提交表单或附带本地数据。报 bug 请附上 `xio doctor`
的输出——里面有复现需要的全部信息，且不含任何密钥。

- Issues：https://github.com/Xio-Shark/xiocode/issues
- 邮箱：xioshark.0127@gmail.com

**无 XioCode 产品遥测。** XioCode 不向自营服务发送产品使用分析数据。模型服务商流量、配置的 MCP/hooks，以及可选的 npm 更新检查，属于 [本地状态](#本地状态) 中说明的其他出站路径。
