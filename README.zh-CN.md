# XioCode 🦈

> 专注于安全性、可恢复性与成本透明的终端 AI 编程助手。  
> 本地优先架构，直连模型端点，具备单轮文件回滚与崩溃会话续跑能力。

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-20.0%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.0-informational.svg)](./package.json)
[![CI](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml/badge.svg)](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml)

---

## 核心特性

- **细粒度版本回滚**：每次代码修改前自动记录工作区轻量快照。支持单轮撤销（`/rollback turn`）与会话基线回滚（`/rollback`），在不污染未暂存本地代码的前提下精准撤销异常变更。
- **工程抗体系统 (Project Immunity Engine)**：零摩擦隐式负向约束蒸馏。当用户触发 `/rollback` 回滚或输入 `! 强干预` 时，自动提炼失败教训，并在后续轮次强约束注入，杜绝同一错误重犯。
- **影响域探查 (Blast Radius Probe)**：公共导出符号 AST 变更探查。跨 TS/JS/Python/Go/Rust 自动识别破坏性签名变更，并实时联动探查工作区所有下游调用方文件与行号。
- **推测性赛马 (Speculative Worktree Racing)**：在独立隔离的 Git Worktree 中并发探索多种解题路径与算法分支，基于自动化测试与最小 Diff (Karpathy Surgical 原则) 自动裁决优胜者并秒级清理废弃分支。
- **状态持久化与断点恢复**：对话上下文、任务目标与执行状态均增量落盘持久化。在终端关闭、系统休眠或进程中断后，通过 `xio resume` 即可原位继续工作。
- **主流模型原生对接**：原生集成 DeepSeek、通义千问 (DashScope)、硅基流动 (SiliconFlow)、智谱 AI (GLM) 以及 Anthropic Claude、OpenAI、Google Gemini 官方端点，无需自建转发代理。
- **实时 Token 成本度量**：终端状态栏按实际 Token 消耗与提供商定价实时计算费用（精确到美分），使用成本清晰透明。
- **双模操作界面**：全屏高密度终端 TUI（语法高亮、模糊搜索、命令面板、鼠标滚动支持），同时内置零依赖本地 Web 控制台（`xio web`），可视化审查工具调用链路与执行时间线。
- **主动安全防护**：对破坏性 Shell 命令与敏感文件修改执行严格拦截与人工授权校验，保障工作区安全。

---

## 安装要求

- **Node.js**: 20.0.0 或更高版本
- **操作系统**: macOS, Linux, Windows (WSL)

```bash
# 推荐：一键安装脚本（自动配置全局环境）
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash

# 或通过 npm 全局安装
npm install -g @xioshark/xiocode
```

指定版本安装：
```bash
export XIO_INSTALL_VERSION=1.3.0
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
```

安装完成后，可通过 `xio` 或 `xiocode` 命令启动。

---

## 快速上手

### 1. 启动交互式会话
在任何代码仓库目录下运行：
```bash
xio
```

### 2. 配置模型凭证
首次使用时，在交互输入框输入：
```text
/connect
```
根据终端引导选择提供商并输入 API Key。凭证经本地加密保存在 `~/.xiocode/`，不向任何第三方云端转发。

### 3. 下发开发任务
在输入框直接描述开发需求：
```text
> 为现有用户认证模块增加 JWT 鉴权与刷新机制，并为边界条件补齐单元测试
```

**常用交互技巧**：
- **实时干涉**：模型生成过程中按回车或输入 `!指示`，可随时暂停并调整方向；
- **上下文注入**：输入 `@` 模糊搜索本地代码文件并添加至上下文；
- **快捷键手册**：在空输入行按 `?` 查看全局键位绑定。

---

## 关键机制

### 代码回滚 (Rollback)
| 命令 | 范围 | 说明 |
| :--- | :--- | :--- |
| `/rollback turn` | 单轮修改 | 仅还原上一轮 Prompt 所修改的文件，保留当前其它未提交改动 |
| `/rollback` | 全会话修改 | 撤销本次会话中所有由 Agent 生成的文件变更，重置回会话初始基线 |

### 会话恢复 (Resume)
如遇系统休眠、终端异常关闭或误触中断，执行现场完整保留：
```bash
xio resume        # 恢复上一次意外退出或中断的会话，任务与上下文原位继续
```

### 本地 Web 控制台 (Web Console)
```bash
xio web           # 启动本地可视化控制台并在浏览器打开 http://localhost:3000
```
提供时间线流水线视图，清晰排查上下文演变、工具入参与执行结果。

---

## 命令参考

### CLI 命令行工具
| 命令 | 说明 |
| :--- | :--- |
| `xio` | 启动交互式终端编程环境 |
| `xio "任务描述"` | 单次执行指定任务，完成后退出 |
| `xio resume` | 恢复上一次中断或退出的会话 |
| `xio web` | 启动本地 Web 控制台 (`http://localhost:3000`) |
| `xio doctor` | 一键诊断系统环境、Node 版本、配置及 API 连通性 |
| `xio models` | 查看支持的模型目录与实时定价表 |

### 会话内指令 (Slash Commands)
| 命令 | 说明 |
| :--- | :--- |
| `/connect` | 配置或切换模型提供商 API Key |
| `/model` | 动态切换当前会话所用的模型 |
| `/rollback turn` | 撤销上一轮的文件修改 |
| `/rollback` | 撤销本次会话的所有文件修改 |
| `/immunity` | 审查或清空当前项目的负向约束抗体 (`/immunity [clear]`) |
| `/race` | 查看推测性 Worktree 赛马引擎状态与说明 |
| `/compact` | 压缩会话历史以释放上下文窗口 |
| `/clear` | 清屏并重置当前视图 |
| `/help` | 查看命令手册与快捷键列表 |

---

## 安全与隐私

1. **本地优先与直连官方**：所有 API 请求直接发往所选模型厂商的官方接口，无任何云端中转服务器。
2. **零用户遥测**：不采集用户源码、Prompt 或操作轨迹；日志与会话数据严格留存于本地 `~/.xiocode/`。
3. **高危操作防御**：破坏性 Shell 命令（如递归删除）与高危文件覆写均受内置安全栅栏拦截，须经用户显式确认后方可执行。

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。使用 XioCode 编写的代码 100% 归用户所有。
