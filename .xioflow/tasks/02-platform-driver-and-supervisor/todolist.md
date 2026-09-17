# Todolist: 真实平台进程驱动、停止确认流水线与端到端恢复闭环 (Task 02)

- [x] **步骤 1：定义平台驱动契约与结构化停止结果**
  - [x] 在 `packages/kernel/src/driver/types.ts` 中定义 `PlatformDriver`、`ProcessIdentity`
  - [x] 定义 `StopProcessResult`（说明 `stopped`、`scope`、`residualPids`、`errorDetails`）
  - [x] 确保区分直接子进程（direct_child）与进程组（process_group）能力

- [x] **步骤 2：实现 Node.js 真实平台进程驱动**
  - [x] 在 `packages/kernel/src/driver/node-driver.ts` 中使用 `node:child_process.spawn` 启动进程
  - [x] 提取真实 `PID` 与操作系统单调时钟生成唯一 `ProcessIdentity`
  - [x] 实现 `verifyIdentity`：通过操作系统进程状态比对三态结果（is_original / not_original / cannot_determine）
  - [x] 实现 `terminate`：分段发送 `SIGINT -> graceMs -> SIGTERM -> SIGKILL` 并返回 `StopProcessResult`

- [x] **步骤 3：实现输出排空泵与有界超时**
  - [x] 内存超 10MB 时设置 `isTruncated = true`，持续使用 `stream.on('data')` 消费管道防止内核缓冲区挂死
  - [x] 等待 stdio 关闭配置有界超时（默认 2000ms），超时后强制记录输出

- [x] **步骤 4：实现停止确认流水线与崩溃恢复引擎**
  - [x] 在 `packages/kernel/src/supervisor/supervisor.ts` 中实现超时/取消转入 `stopping`
  - [x] 经驱动确认停止后，原子提交 `cancelled` 或 `timed_out` 并释放资源
  - [x] 若驱动返回无法确认，提交 `indeterminate` 并保留资源隔离
  - [x] 在 `packages/kernel/src/recovery/engine.ts` 中联合 Task 01 实现基于 SQLite 的崩溃恢复

- [x] **步骤 5：构建无头 API 契约与故障注入测试套件**
  - [x] 编写 `packages/kernel/tests/supervisor/contract.test.ts`
  - [x] 注入 6 项关键崩溃场景测试（意图后崩溃、启动后崩溃、取消中崩溃、旧进程存活、独立操作继续）
  - [x] 记录真实测试输出至 `verification.md`
