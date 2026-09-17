# PRD: 真实平台进程驱动、停止确认流水线与端到端恢复闭环 (Task 02)

## 1. 需求背景与定位

### 1.1 核心定位
- **归属**：`xioflow` 共享内核执行与驱动能力。
- **目标**：接入真实 Node.js 平台驱动，补齐停止确认（`stopping`）、微秒时钟身份核验与有界排空；联合 Task 01 的 SQLite 事务存储，打通从启动意图到崩溃恢复的完整闭环，并**直接在此阶段落地无头 API 契约测试**。

### 1.2 解决的关键缺陷
1. **取消不是立刻成功**：超时或取消请求不能盲目标记 `cancelled`。必须先进入 `stopping`，经平台驱动确认已退出后才转终态；若无法确认则转为 `indeterminate`，**绝对不释放冲突资源**；
2. **PID 复用误杀**：驱动必须提供真实出生时钟核验，返回三态结果（`is_original_process` / `not_original_process` / `cannot_determine`），无法确认时不盲目强杀；
3. **输出收尾无限挂起与缓冲区死锁**：后代孤儿持有句柄会导致 stdio 永久无法 close；内存上限满后停止读取会导致 OS 内核管道死锁。必须持续排空且设置有界排空期限；
4. **无头契约验证前置**：不能等发行版做完才测内核，第一阶段就必须用无界面、无 LLM 的纯 API 消费者验证恢复与监督契约。

---

## 2. 核心功能与协议规范

### 2.1 PlatformDriver 平台驱动实现
- 抽象能力契约：声明直接子进程与进程组（PGID）管理支持度；
- `spawn(command)`：通过参数数组启动，提取真实 `PID` 与操作系统单调创建时间戳；
- `verifyIdentity(identity)`：向操作系统查询该 PID 的创建时钟是否匹配，判定是否为原进程；
- `terminate(identity, graceMs)`：发送 `SIGINT -> 宽限期 -> SIGTERM -> SIGKILL`，返回结构化 `StopProcessResult`（说明是否确认停止、作用范围与存疑 PID）。

### 2.2 有界排空与截断保护
- 内存保留缓冲上限默认 10MB；
- 超出 10MB 时设置 `isTruncated = true`，停止向内存追加，但**必须持续挂载流监听并消耗（drain）数据**，防止操作系统内核管道缓冲区（通常 64KB）填满导致子进程挂死；
- 等待 stdio 完全关闭配置有界排空超时（默认 2000ms），超时后强制记录输出结果并收尾。

### 2.3 联合崩溃恢复与故障注入测试套件 (Crash Injection Suite)
在无头 API 消费者中执行关键故障注入验证：
1. **意图登记后、驱动启动前崩溃**：重启时扫描未启动意图，安全释放隔离资源；
2. **驱动启动成功、身份未提交前崩溃**：重启时凭登记指纹与驱动握手核验，确认存活则纳入监督；
3. **操作已完成、终态未提交前崩溃**：通过执行凭证核对，补齐终态；
4. **取消与退出竞态**：进程恰好在收到 SIGINT 时自然退出，驱动正确判定真实退出码与信号；
5. **旧进程仍在运行**：重启时核验证实为原进程，推进停止流水线并确认；
6. **独立运行继续**：某操作进入 `indeterminate` 隔离后，已证明无资源冲突的其他运行顺畅继续。

---

## 3. 验收标准与交付物

1. **源代码交付（在 xioflow 仓库内）**：
   - `packages/kernel/src/driver/types.ts`：平台驱动接口与结构化停止结果；
   - `packages/kernel/src/driver/node-driver.ts`：Node.js 真实进程驱动实现；
   - `packages/kernel/src/supervisor/supervisor.ts`：前台受监督执行器；
   - `packages/kernel/src/recovery/engine.ts`：崩溃恢复执行引擎；
   - `packages/kernel/tests/supervisor/contract.test.ts`：无头 API 契约与故障注入测试套件。
2. **测试验证**：
   - 6 项故障注入测试 100% 通过；
   - 50MB 日志流压测顺畅退出并标记 `isTruncated: true`；
   - 超时进入 `stopping` 并经驱动确认停止后才释放资源锁。
