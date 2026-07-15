# XioCode

本地终端里的 AI 写代码助手。代码在你自己的电脑上改，记录也留在本机；合进主分支前会问你，不会自动偷偷合并。

仓库：<https://github.com/Xio-Shark/xiocode>  
英文说明：[README.md](./README.md)

---

## 它能干什么

- 在终端里对话，让 AI 读仓库、改文件、跑命令
- 默认在**独立的工作副本**里改代码，保护你的主目录
- 想把改动合回主项目时，用 `/merge` 或结束会话时确认
- 支持常见模型接口（如 DeepSeek 等，在配置里填）
- 可选：并行只读「探查」子任务、计划清单、会话压缩等

**不是什么：** 不是云端托管服务；也不是「测绿了就自动合进 main」。

---

## 环境要求

- **Node.js 22.6 或更高**（用系统自带的 `node` / `npm` 即可）
- 在一个 **git 仓库**里使用（非 git 目录会直接拒绝进入）
- 准备好模型 API Key（环境变量或首次进入后用 `/connect`）

---

## 安装（推荐两种）

### 方式一：一行安装（curl）

从 GitHub 装全局命令 `xio` / `xiocode`：

```bash
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
```

装完后一般会自动创建本机配置目录（若不存在）。

指定某个发布版本（打了 tag 之后）：

```bash
# 把 v1.1.0 换成 Release 页面上的版本号
export XIO_INSTALL_REF=v1.1.0
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/${XIO_INSTALL_REF}/install.sh | bash
```

### 方式二：npm 全局安装

```bash
# 跟踪 main 分支最新提交
npm install -g github:Xio-Shark/xiocode

# 或固定版本 tag（推荐日常使用）
npm install -g github:Xio-Shark/xiocode#v1.1.0
```

装好后确认：

```bash
xio --version
# 或
xiocode --version
```

若提示找不到命令：把 `npm prefix -g` 下面的 `bin` 加到 PATH，再开一个终端。

### 方式三：从源码开发

```bash
git clone https://github.com/Xio-Shark/xiocode.git
cd xiocode
npm install --ignore-scripts
npm link
```

---

## 第一次使用

```bash
cd /你的项目  # 必须是 git 仓库
export DEEPSEEK_API_KEY=你的密钥   # 按你实际用的服务改环境变量名
xio
```

也可以不把密钥写在 shell 里：进终端界面后用 `/connect`，密钥会写到本机 `~/.xiocode/credentials.json`（权限较严），**不要**写进项目仓库。

首次运行会生成 `~/.xiocode/config.toml`（没有才创建）。也可手动：

```bash
xio init
```

---

## 本机目录说明（隐私相关）

这些都在**你的用户主目录**下，**默认不会、也不应提交到 GitHub**：

| 路径 | 用途 |
|------|------|
| `~/.xiocode/config.toml` | 模型与开关配置（不写密钥明文） |
| `~/.xiocode/credentials.json` | 本机登录/密钥 |
| `~/.xiocode/runs/` | 运行记录 |
| `~/.xiocode/sessions/` | 可恢复的对话 |
| `~/.xiocode/worktrees/` | 会话用的 git 工作副本 |

项目里的 agent 约定建议沿用 Claude Code 习惯：`CLAUDE.md`、`.claude/skills/` 等；**密钥永远不要进 git**。

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `xio` | 进入交互界面 |
| `xio -p "一句话任务"` | 非交互跑一轮（适合脚本） |
| `xio init` | 补全默认配置 |
| `xio models` | 看模型列表 |
| `xio resume` | 恢复以前的会话 |
| `xio improve` | 改进 XioCode 自身（仍会询问是否合并） |
| `xio eval` / `xio regress` | 评测与私有回归（进阶） |

交互里常用：`/merge` 合入、`/compact` 压缩上下文、`/help` 帮助。

---

## 发布版本（Release）怎么用、怎么做

### 用户怎么装「某一个版本」

1. 打开：<https://github.com/Xio-Shark/xiocode/releases>  
2. 选中版本号，例如 `v1.1.0`  
3. 安装：

```bash
# curl：指定 REF
export XIO_INSTALL_REF=v1.1.0
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/v1.1.0/install.sh | bash

# npm：指定 tag
npm install -g github:Xio-Shark/xiocode#v1.1.0
```

**说明：**

- 当前安装链路走的是 **GitHub 仓库 + npm install -g github:…**，**不强制**发布到 npm 官网公共包名。
- 若以后要在 `npm install -g xiocode` 用公共 registry，需要维护者登录 npm 后执行 `npm publish`（另一步，与 git tag 独立）。

### 维护者如何打一个 Release（本仓库）

前提：代码已推到 `main`，且 **不含** 密钥、本机 `~/.xiocode`、个人 IDE 配置。

```bash
# 1) 确认 package.json 里 version 与 tag 一致，例如 1.1.0
# 2) 打 tag 并推送
git tag -a v1.1.0 -m "XioCode 1.1.0"
git push origin v1.1.0
git push origin main

# 3) 在 GitHub 上建 Release（有 gh 时）
gh release create v1.1.0 --title "v1.1.0" --notes "安装：curl 安装脚本 或 npm install -g github:Xio-Shark/xiocode#v1.1.0"
```

用户侧的 curl/npm **不依赖** Release 附件里的二进制；Release 主要用于固定版本号与发布说明。安装仍从该 tag 的源码树拉取。

---

## 上传代码时不要带这些

请勿提交：

- 任何 API Key、`.env`、`credentials.json`
- 本机 `~/.xiocode/` 下的 runs / sessions / worktrees
- 个人 `.cursor/`、`.claude/settings.local.json` 等（仓库 `.gitignore` 已忽略常见项）
- 公司内部未授权代码、客户数据

本仓库只应包含 **XioCode 产品源码与文档**。

---

## 验证与开发

```bash
npm run check    # 类型检查
./test.sh        # 测试（跳过需要真实 API Key 的端到端）
```

更多产品目标与状态见 `docs/GOAL.md`、`docs/STATUS.md`（偏开发者）。

---

## 许可证

[PolyForm Noncommercial](./LICENSE)（非商业许可；细节以 LICENSE 为准）。

---

## 问题反馈

- Issues：<https://github.com/Xio-Shark/xiocode/issues>
