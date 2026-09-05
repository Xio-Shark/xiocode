# XioCode 🦈

> 运行在终端里的 AI 编程助手：**可随时中断、支持单轮撤销、会话状态持久保存**。  
> 密钥直连官方，代码全在本地执行；没有云端中转，用量计费实时透明。

**English → [README.md](./README.md)**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-22.6%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.0-informational.svg)](./package.json)
[![CI](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml/badge.svg)](https://github.com/Xio-Shark/xiocode/actions/workflows/ci.yml)

---

## 为什么要做 XioCode？

市面上的 AI 编程工具很多，但在实际工程中，最容易打断开发节奏的往往是：
- **不敢让 AI 大幅度改动**：一旦修改涉及多个文件且偏离预期，难以精确定位和干净撤回；
- **长任务中途异常中断**：终端意外关闭、电脑休眠或误触中断后，会话上下文直接丢失，只能重头再来；
- **模型对接繁琐、费用模糊**：需要反复折腾代理转发，计费缺乏实时展示，使用成本不透明。

**XioCode 聚焦于提供安全、受控且可恢复的终端编程体验：**

```
┌────────────────────────────────────────────────────────┐
│                      你的终端                          │
│                                                        │
│  $ xio "重构支付模块，增加微信支付与退款接口"           │
│                                                        │
│  XioCode:                                              │
│    · 自动记录工作区状态快照                            │
│    · 结合项目结构分析调用链路                          │
│    · 实时修改文件并展示清晰 Diff                       │
│    · 遇到高危命令主动请求人工确认                      │
│                                                        │
│  想要撤销改动？ 输入 /rollback turn 立即复原上一轮     │
│  终端意外关闭？ 输入 xio resume 从中断点原地继续       │
└────────────────────────────────────────────────────────┘
```

---

## 核心特性

### 1. 细粒度版本回滚：改动不满意，一键安全撤回
AI 批量修改多个文件后，手动排查与还原成本极高。  
XioCode 在每次执行修改前自动记录工作区轻量快照：
- **撤销单轮改动**：输入 `/rollback turn`，上一轮触碰的文件立即恢复原状，且绝不会影响你原有的未提交修改；
- **恢复会话初始**：输入 `/rollback`，直接还原到会话开始时的基准状态。

### 2. 会话断点续跑：意外中断无需从头开始
复杂任务执行中途若遭遇笔记本休眠、终端意外退出或误按中断，不必重新组织上下文。  
XioCode 对执行步骤进行增量持久化：
```bash
$ xio resume        # 重新加载会话，对话历史、任务进度与上下文原位恢复
```

### 3. 主流模型原生对接，用量与花销实时透明
全面支持国内外主流模型供应商，直接对接官方 API，无需繁琐的中间代理：
- **国内主流**：DeepSeek、通义千问 (DashScope)、硅基流动 (SiliconFlow)、智谱 AI (GLM) 等
- **国际主流**：Anthropic Claude、OpenAI、Google Gemini 等

终端状态栏按实际 Token 消耗实时计算费用（精确到美分），使用成本清晰透明。

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
| `/rollback turn` | **单轮回滚**：仅撤销上一轮修改的所有文件 |
| `/rollback` | **完整回滚**：撤销当前会话中的全部文件修改，恢复到会话初始状态 |
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
