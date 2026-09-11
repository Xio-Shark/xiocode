# 浏览器 MCP 接入记（P0/P1/P2 实测）

> 目标：模型能直接用你的登录态操作网站，且不因此增加往返次数与常驻 prompt 厚度。
> 本文只记录**实测数字与已定决策**，不含推测。

**更新日期**：2026-09-11

---

## 一、三个可验收指标（当前基线）

| 需求 | 指标 | 基线 | 接入后 |
|---|---|---|---|
| 模型快 | 每往返完成的动作数 | 1.28 工具调用/往返，往返中位数 4.8s | 浏览器动作同批串行，单批可 ≥3 个 |
| 约束薄 | 常驻 prompt 增量 | system prompt 692 字符 + 工具块 5,617 字符 | prompt 684 字符；工具块 +1,621 字符（description+名称）= +29% |
| 能操作登录态浏览器 | 目标站点免二次登录直达 | 无浏览器能力 | 扩展桥（`--extension`）继承日常 Chrome |

## 二、架构决策

用 **Playwright MCP**（`@playwright/mcp`），不自写 CDP 封装、不自造扩展。三种 profile 模式：

| 模式 | 命令 | 登录态 | 隔离 |
|---|---|---|---|
| **扩展桥（选定）** | `--extension` | 完整继承你正在用的 Chrome | 无 |
| CDP attach | `--cdp-endpoint ... --user-data-dir=<专用目录>` | 有 | 无 |
| profile 副本 / storage-state | `--user-data-dir=<副本>` / `--storage-state <导出文件>` | 同机同用户可解 cookie | 弱 |

- `--user-data-dir` 在 CDP 模式下是**强制**的：Chrome 136 起远程调试对默认 profile 目录不再生效。
- 感知层用 **a11y 快照**，不开 `vision` 能力（截图 + 视觉模型的 token 与延迟是快照的数倍）。
- macOS 的 `Chrome Safe Storage` 密钥是**机器+用户级**，所以同机换 profile 目录 cookie 仍能解密。

## 三、P1：往返压缩（本仓库已实现）

浏览器动作天然有序（`goto → click → type`），但原先调度器会把同一轮里的 MCP 调用**并行**发出 → 竞态点击。
根因不是 `WRITE_SERIAL_TOOLS` 少一个名字，而是串行队列的 key 取 `filePath || "__anon_write_" + call.id`：
浏览器工具没有 `path` 参数 → 每次得到唯一 key → **即使加进串行集合也照样并发**。

改动（`src/runtime`）：

- `serial-queue.ts`：按显式 key FIFO 串行（不复用 `FileWriteQueue`——它先 `fs.realpath(key)`，对 `"browser"` 这类非路径 key 会解析成 `<cwd>/browser`）。
- `streaming-tool-scheduler.ts`：`isBrowserMcpTool()` 识别 `mcp__<server>__` 里的浏览器族（`playwright/playwrightmcp/browser/browsermcp/chrome/puppeteer/selenium`，大小写与横线不敏感）；`toolSerialQueueKey()` 统一给出队列 key（write → 文件路径，浏览器 → 全族共用一个 key，其余 → `undefined` 保持并行）。
- `agent-loop.ts`：流式与批量两条路径都接入族队列。
- `system-prompt.ts`：加「一轮内按序给出完整动作序列，等待用导航或网络事件，不用固定 sleep」，同时删掉等量冗余，净 **-8 字符**。

效果：naive 循环 `navigate→snap→click→snap→type→snap` = 8 次往返 → 同批串行后 **2–3 次往返**。

## 四、P2：约束瘦身（已做：客户端工具白名单）

实测 `@playwright/mcp@latest`：**24 个工具**，description 1,621 字符 / inputSchema 12,829 字符。

- `--caps core` **不裁剪**：显式传 `--caps core` 与默认返回完全相同的 24 个工具（该参数是「启用额外能力」而非「只留这些」），服务端没有可用裁剪路径。
- 因此在 xiocode 侧加了 `[mcp.servers.<name>] tools = [...]` 白名单（`XioMcpServerConfig` → `parseServerSpec` → 注册时按 server 上报的工具名过滤，未列出的不注册并打一条 warning）。规则在 `extensions/xio-hygiene/src/mcp.ts`，单测见 `extensions/xio-hygiene/test/mcp.test.ts › tool allowlist keeps listed tools and drops the rest`。
- 当前 `~/.xiocode/config.toml` 只放行 14 个：navigate / find / click / type / press_key / fill_form / select_option / hover / wait_for / tabs / evaluate / network_requests / network_request / handle_dialog。
- **砍掉的核心是整页 `browser_snapshot`**：GitHub 通知页一次 616 行，实测单请求 input 涨到 20 万 token，且必然 spill → 模型再读 → 再 spill（每次任务多 2–3 个往返）。替代路径实测可行：`browser_find({text})` 只回 359 字符、且**带 `[ref=eN]` 可直接喂 click/type**（探针 `scripts/mcp-find-probe.mjs`）。
- 踩坑：白名单留了 `browser_evaluate` 时，模型会把它当锤子——实测出现 **17 次连续 evaluate、20 个往返、231s**。同一配置换次跑又是 10 往返/66s，方差极大，因此结论按 2–3 次测量取，不按单次。

## 五、安全边界

1. `allow_high_risk = true` → 会话以 **permission mode = full** 启动（`resolveInitialPermissionMode`），即 `mcp__*` 高风险工具自动放行、不弹确认。恢复逐个确认：改 `false`（默认 auto）或会话内 `/permission auto`。
2. `--allowed-origins` / `--blocked-origins` **不是安全边界**（官方 README 原话：does not serve as a security boundary and does not affect redirects）。
3. 不要用 `--cdp-endpoint` 挂日常 Chrome：那等于把带全部登录态的调试端口开在本机。要用 CDP 就配专用 `--user-data-dir` 且只绑 `127.0.0.1`。扩展桥不暴露调试端口。

## 六、扩展安装（`--extension` 模式的前提）

Chrome 商店版即可；从源码构建时**不能直接 Load unpacked 源码目录**（manifest 指向的 `lib/background.mjs` 需要构建产物）：

```bash
cd playwright-<version>            # microsoft/playwright 源码
npm ci                             # 扩展只依赖 react，不需要构建整个 core
cd packages/extension && npx vite build
# 然后 chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 packages/extension/dist
```

- 扩展 ID 由 manifest 的 `key` 决定：`mmlmfjhmonkocbjadbfplnigmagldckm`（与本机 playwright-core 里的常量一致）。
- **首次连接需要人工点一次 Allow**：扩展会开一个标签页选择页（selector），把 MCP relay 连接与选中的标签绑定；之后同一会话内不再问。
- 检测是否已安装（调 playwright-core 自己的判定逻辑）：

```bash
node -e 'const {findPlaywrightExtensionProfile}=require("playwright-core/lib/tools/utils/extension.js");findPlaywrightExtensionProfile(process.env.HOME+"/Library/Application Support/Google/Chrome").then(p=>console.log(p??"none"))'
```

## 七、探针脚本（本仓库）

| 脚本 | 用途 | 是否需要登录态 |
|---|---|---|
| `scripts/mcp-tool-inventory.mjs` | 量某 MCP server 的常驻工具块成本（工具数 / description / schema 字符） | 否，不调用任何工具 |
| `scripts/mcp-browser-smoke.mjs` | headless + 一次性 profile 真跑 `navigate` + `snapshot`，验证链路与快照成本 | 否 |
| `scripts/mcp-extension-probe.mjs` | 走 `--extension` 连真实 Chrome，只 `browser_tabs` 列标签，不动页面 | 是（需先点 Allow） |
| `scripts/count-run-events.mjs` | 从 `--output-format stream-json` 统计往返数与工具直方图（`tool.batch` span 只在 perf tracer 里，不在此列） | 否 |

用法：

```bash
node scripts/mcp-tool-inventory.mjs -- npx -y @playwright/mcp@latest
node scripts/mcp-browser-smoke.mjs https://example.com
node scripts/mcp-extension-probe.mjs --action tabs
```

实测（2026-09-11，headless 探针）：connect 2,147ms → `browser_navigate` 7,893ms → `browser_snapshot` **3ms**，a11y 快照 411 字符（带 `[ref=eN]` 引用）。

## 八、验收用例

```bash
xio -p "打开 https://github.com/notifications 读出前 3 条标题，一轮内给出完整动作序列"
```

看两个数：`provider.request` span 数下降 ≥50%，`tool.batch` 单批工具数从 1 升到 ≥3。

**2026-09-11 实测（同一任务、同一 dist，量法：`--output-format stream-json | scripts/count-run-events.mjs`）**

| 阶段 | 往返 | 耗时 | 观察 |
|---|---|---|---|
| 修复前（P1 未做） | 9 | — | 一轮一个工具，navigate→snap→read→read→… |
| P1 + read cap | 6 | 43s | 同批可发多个；read 恰好 2 次覆盖 |
| 白名单 + find 规则（3 次） | 5–8 | 34–59s | 全部走 `navigate` + `browser_find`×2，**零整页快照** |

同一配置三次测量：5 / 8 / 2 往返，方差主要来自模型选路（给它 `browser_find` + 正则提示的那次只要 2 个往返、30s）。因此评测按 2–3 次取中位数，不按单次。

## 九、踩坑记录：网关 400 与浏览器接入无关

首次跑验收时 `xio` 任何请求都返回 `LLM request failed (400)`，一度怀疑是新增 24 个 MCP 工具把 payload 撑坏。实测排除了：把浏览器任务换成最小请求（`-p "回复 ok"`）同样 400，说明是 provider 侧问题。

直接探网关拿到的真实错误（xiocode 出于安全不回显 response body，这段是手工 curl 的结果）：

```
POST https://opencode.ai/zen/go/v1/chat/completions
{"type":"error","error":{"type":"MissingSessionID",
 "message":"Error from provider (Console Go): Request is missing x-opencode-session and cannot be routed efficiently."}}
```

- **根因**：Go 网关要求每个会话带稳定 `x-opencode-session`；缺头直接 400。官方文档还要求客户端自报 user-agent，不要用通用 SDK/HTTP 库名（Node 的 undici 默认头属于后者）。xiocode 两者都不发。
- **修法**（无需改代码，`XioProviderConfig` 已支持 `headers`）：

```toml
[providers.opencode]
headers = { "x-opencode-session" = "xiocode-1.3.0", "user-agent" = "xiocode/1.3.0" }
```

- **遗留**：当前是静态 id。网关按「一个 id = 一个会话」优化路由与 prompt cache，跨会话共用一个 id 会削弱缓存收益。要做到每会话一个 id，需要在会话 bootstrap 时把 header 注入 registration（`src/cli/xio-extension.ts` 构建 `models[0].headers`，`src/runtime/providers/client.ts` 在 client 创建时读取一次）——目前未做，记录待办。

## 十、工具面实测修正：动作工具的参数名是 `target`（2026-09-12）

实测 schema（headless 探针列全部 24 个工具）：

| 工具 | required | 可选 |
|---|---|---|
| `browser_click` / `browser_hover` | `target` | `element`（人类可读标签）、`button`、`modifiers` |
| `browser_type` | `target`, `text` | `submit`、`slowly` |
| `browser_select_option` | `target`, `values` | — |

模型猜 `ref` 时会拿到 `Invalid input: expected string, received undefined → at target`，或命中元素后 5s 超时。**这不是页面问题**：

- 能力探针（`scripts/mcp-click-probe.mjs`，走扩展桥、真 Chrome）：`browser_find` 取 `ref=f1e226` → `browser_click{target:"f1e226"}` → **1.9s 成功**，页面跳到对应 CI run。
- 加 `--timeout-action 15000` 反而失败，因为那是**陈旧 ref**（上次点击后页面已导航）。用 ref 前先确认页面状态。
- harness 侧因此加了跨模型别名归一：`applyMcpArgAliases()` 在 schema 声明了 `target` 且未声明 `ref` 时把 `ref` 改写成 `target`（`extensions/xio-hygiene/src/mcp.ts`，单测 `applyMcpArgAliases`）。这是产品级修复，不该靠 prompt 祈祷模型记住 key 名。

**顺带否定一个假设**：加白名单前模型常用 `browser_evaluate` 直接取 href 绕过点击失败，当时看着像"evaluate 救命"。用正确参数名后点击本就成功，所以 evaluate 的去留必须用点击任务重新测，旧数据不足以判断。

## 十一、命令白名单：`~` 误判（已修）

`cat ~/.claude/AGENTS.ondemand.md` 被拒的原因不是"复杂 shell 语法"，而是 `~` 在 `SHELL_METACHAR` 里。三态实测：

| 命令 | 判定 | 原因 |
|---|---|---|
| `cat ~/.claude/AGENTS.ondemand.md` | confirm | complex-shell（`~`） |
| `cat /Users/xioshark/.claude/...` | confirm | unknown-command（词法通过，`cat` 未放行） |
| `sed -n 1,160p /tmp/x` | confirm | unknown-command（`sed` 未放行） |

修法（`src/runtime/command-risk.ts`）：`~` 从元字符表移除，改为**只接受整 token 的前导 `~`/`~/...`**，展开成真实 home 后再做 allowlist 匹配（`ls` 规则原本只收相对路径，故展开后按"home 下的绝对路径"同等对待）。风险识别保留：`~user/x`、`ls /tmp/~x`、`ls ~/a/../b`、`ls /etc`、`ls "$HOME/x"`、`sed -i` 均仍要确认；没有 home 可展开时 fail closed。单测见 `src/runtime/command-risk.test.ts`。

其余（`cat`/`sed`/`head` 不带引号也被拒）属"未放行"而非误判 —— 要放行是改 `~/.xiocode/config.toml` 的 `permissions.allow`，不是改判定逻辑。

## 十二、不要做

- 自写 CDP 封装 / 自造浏览器扩展（两条路官方都有现成的）。
- 截图 + 视觉模型当默认感知。
- 把宿主 profile 拷进 Linux 容器（解不开 cookie）。
- 为浏览器注册 20 个独立工具（违反「约束不能过于复杂」）。
- 用 `Runtime.evaluate` 直接改 DOM 当默认动作（`isTrusted: false` + React 受控组件状态不同步）。
