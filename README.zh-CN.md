# XioCode 🦈

> 住在终端里的 AI 编程搭档：**随时敢关、随时能退、绝不乱动你的代码库**。  
> 密钥你自己带，代码只在本地跑；没有中间商偷看，每一分钱都明明白白。

**English → [README.md](./README.md)**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-22.6%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.0-informational.svg)](./package.json)
[![CI](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml/badge.svg)](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml)

---

## 为什么要做 XioCode？

市面上的 AI 编程工具很多，但日常写代码时，最让人头疼的往往不是 AI “写得不够快”，而是：
- **不敢让它随便改**：一旦改坏了七八个文件，满屏幕都是红色的报错和改动，撤销起来痛苦万分；
- **任务中途断了就白费**：终端不小心关了、笔记本合盖休眠了，再开就全丢了，只能重头再来；
- **国内模型像二等公民**：配置繁琐、经常断连、花销全靠猜。

**XioCode 就是为了解决这些日常烦恼而生的：**

```
┌────────────────────────────────────────────────────────┐
│                      你的终端                          │
│                                                        │
│  $ xio "重构支付模块，增加微信支付与退款接口"           │
│                                                        │
│  XioCode:                                              │
│    · 自动拍下代码快照（带后悔药）                      │
│    · 读懂现有项目结构                                  │
│    · 实时修改文件，展示每一行差异                      │
│    · 遇到危险命令主动停下等确认                        │
│                                                        │
│  觉得改烂了？ 敲 `/rollback turn` 一秒回到改动前       │
│  电脑死机了？ 敲 `xio resume` 从断点原地满血复活       │
└────────────────────────────────────────────────────────┘
```

---

## 三大核心特性（大白话版）

### 1. 💊 真正的“后悔药”，改烂了随时一秒撤回
很多时候 AI 改代码改到一半走偏了，你只能靠 `git diff` 痛苦人肉排查。  
在 XioCode 里，每次它动手前都会在后台**自动拍下轻量快照**：
- **只想撤销刚刚这一轮改动？** 输入 `/rollback turn`，上一轮碰过的文件瞬间复原，且绝不会误伤你原来还没提交的改动！
- **想彻底放弃这次对话的所有改动？** 输入 `/rollback`，直接还原到刚开会话时的样子。

### 2. ⚡ 掉电、崩溃、误按 Ctrl+C，现场永远都在
任务执行到第 8 步，笔记本没电关机了？或者你不小心按了中断？  
别慌。XioCode 的每一步都有增量存档：
```bash
$ xio resume        # 重新拉起会话，对话记忆、执行状态、未完成的任务全部原地继续！
```

### 3. 🇨🇳 国产模型一等公民，花钱清清楚楚
原生集成 **DeepSeek、通义千问 (DashScope)、硅基流动 (SiliconFlow)、智谱 AI (GLM)**，海外的 OpenAI、Claude、Gemini 也样样精通。  
终端底部实时显示**真实花费（美元/美分）**，按实际消耗精确计价，绝不拿 `$0` 忽悠你。

---

## 一键安装

需要 **Node.js 22.6+**（如果系统没有，安装脚本会自动指引）。

```bash
# 推荐：一键安装脚本（自动配置全局环境）
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash

# 或者通过 npm 全局安装
npm install -g @xioshark/xiocode
```

指定版本安装：
```bash
export XIO_INSTALL_VERSION=1.3.0
curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
```

安装完成后，直接可以使用 `xio` 或 `xiocode` 命令。

---

## 3 分钟快速上手

### 1. 打开项目并启动
进入你的任何代码项目目录，敲：
```bash
xio
```

### 2. 配置 API Key（无需手动折腾环境变量）
第一次打开如果没有 Key，敲：
```text
/connect
```
按方向键选择你的服务商（如 DeepSeek、SiliconFlow 等），把 Key 粘贴进去。它会安全地保存在本地电脑上，以后启动再也不用配一遍。

### 3. 开始派活！
直接在输入框打字：
```text
> 帮我写一个用户注册接口，包含邮箱格式校验、密码加盐加密，并补齐单测
```

日常实用快捷手势：
- **插话与引导**：AI 正在输出时，按回车或输入 `!你的指示` 即可让它随时停下来听你说；
- **引用文件**：输入 `@文件名` 就能模糊搜索本地代码文件并快速带给 AI 看；
- **查看快捷键**：在空输入行按 `?` 即可打开全局快捷键表。

---

## 终端与 Web 界面双修

- **纯正终端 TUI**（输入 `xio`）：全屏交互、Markdown 代码高亮、鼠标丝滑滚轮、`Ctrl+P` 模糊命令、`Ctrl+F` 日志搜索。
- **本地 Web 控制台**（输入 `xio web`）：在浏览器里打开超轻量的时间线控制台，像看流水线瀑布一样清晰排查每一次模型回答与工具调用细节。

---

## 常用命令一览

### 命令行工具
| 命令 | 说明 |
|------|------|
| `xio` | 进入交互式终端编程环境 |
| `xio "需求描述"` | 单次执行任务（跑完即退出） |
| `xio resume` | 恢复上一次意外中断或退出的会话 |
| `xio web` | 启动本地网页版控制台 (`http://localhost:3000`) |
| `xio doctor` | 一键检查系统环境、Node 版本、配置和 API 连通性 |
| `xio models` | 查看支持的模型和价格表 |

### 会话内指令（敲 `/` 唤出）
| 斜杠命令 | 说明 |
|----------|------|
| `/connect` | 切换或绑定新的模型 API Key |
| `/model` | 临时切换当前使用的模型 |
| `/rollback turn` | **后悔药**：撤销上一轮改动的所有文件 |
| `/rollback` | **大回滚**：撤销本会话的所有文件改动，重置回刚启动时的状态 |
| `/compact` | 对话太长占用额度时，一键智能压缩聊天历史 |
| `/help` | 打开快捷键与命令手册（或直接按 `?`） |

---

## 隐私与安全承诺

1. **没有云端中转站**：XioCode 不架设任何中间转发服务器，你的请求从本地直接发往你配置的模型官方端点；
2. **零后台遥测**：不偷偷搜集你的代码、Prompt 或操作轨迹，本地日志全部保存在 `~/.xiocode/` 目录下；
3. **危险操作强拦截**：AI 尝试执行 `rm -rf` 等破坏性命令时，会立即暂停并弹出红字提醒，必须由你手动按 `y` 才会执行。

---

## 开源协议

**[MIT](./LICENSE)** —— 免费、开源，无论是个人、开源项目还是商业闭环，想怎么用就怎么用。你用 XioCode 写出的代码永远 100% 属于你自己。
