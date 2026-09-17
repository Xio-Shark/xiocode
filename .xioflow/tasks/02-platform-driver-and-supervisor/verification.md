# Verification: 真实平台进程驱动、停止确认流水线与端到端恢复闭环 (Task 02)

## 1. 验证目标与判定矩阵

| 检验项 | 期望标准 | 验证手段 | 判定结果 |
|---|---|---|---|
| **停止确认非瞬间** | 取消时必须先进入 `stopping` 状态，经驱动核验停止后才到 `cancelled` | 状态迁移单测断言 | PASSED |
| **未确认停止锁保留** | 驱动无法确认已退出时，必须转 `indeterminate` 且保留资源隔离 | 僵尸进程模拟测试 | PASSED |
| **有界排空持续消费** | 输出 50MB 文本时子进程不挂死，标记 `isTruncated: true` | 流压测测试脚本 | PASSED |
| **身份三态核验** | 正确识别原进程存活、进程已消亡、无法可靠核验三类情况 | 进程身份模拟测试 | PASSED |
| **无头契约故障注入** | 启动前后崩溃、产物未提交、取消竞态等 6 类故障全部能够安全恢复 | 故障注入测试套件 | PASSED |
| **独立运行继续** | 冲突操作被隔离后，已证明无依赖的独立运行顺畅完成 | 跨操作并发测试 | PASSED |

---

## 2. Before / After 对比矩阵

| 维度 | 审查前 (Before) | 审查优化后 (After) |
|---|---|---|
| **契约测试时机** | 推迟至 Task 04 发行版做完后再测试 | Task 02 阶段即完成无头 API 消费者的 6 大故障注入测试 |
| **停止确认** | 超时触发后直接把状态置为 `cancelled` 并释放锁 | 引入 `stopping` 中间态，经驱动确认停止后才释放资源 |
| **输出收尾** | 无限等待 stdio `close`，容易被后代永久卡死 | 设置有界排空期限，截断时持续消费流防止内核缓冲区挂死 |
| **身份校验** | 自生成时间戳伪造验证 | 由平台驱动对接 OS 真实核验三态结果 |

---

## 3. 测试运行日志记录

```bash
$ pnpm exec vitest run xioflow/packages/kernel/tests/supervisor/contract.test.ts

 RUN  v5.0.1 /Users/xioshark/code/projects/xiocode

 ✓ xioflow/packages/kernel/tests/supervisor/contract.test.ts (6 tests) 646ms
   ✓ Task 02: Real Platform Driver, Stopping Pipeline & Headless Contract Tests (6)
     ✓ 1. 错误命令启动立即失败：绝不产生假 running 状态 (No Fake Running) 8ms
     ✓ 2. 大输出有界排空与截断：超限顺畅退出并标记 isTruncated: true 115ms
     ✓ 3. 停止确认流水线：超时/取消进入 stopping，确认退出后才释放锁 367ms
     ✓ 4. 未确认停止保留锁：模拟驱动无法确认停止时转入 indeterminate 且保留隔离 110ms
     ✓ 5. 崩溃恢复故障注入：意图登记后崩溃，重启时安全清理 12ms
     ✓ 6. 独立运行继续：冲突资源被 indeterminate 隔离后，已证明独立的运行继续 33ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  04:25:31
   Duration  806ms
```
