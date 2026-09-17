# Verification: xiocode 最小发行版闭环与 8 项跨装配契约验收 (Task 04)

## 1. 验证目标与判定矩阵

| 检验项 | 期望标准 | 验证手段 | 判定结果 |
|---|---|---|---|
| **契约 1: 错误命令启动** | 启动无效程序立即退出，不产生 fake running | 状态规则断言 | PASSED |
| **契约 2: 大量输出不阻塞** | 产生 50MB 日志不挂死，标记 `isTruncated = true` | 流压测试验 | PASSED |
| **契约 3: 未确认停止保留锁** | 处于 `stopping` 未完成时，锁绝对不释放 | 资源竞争单测 | PASSED |
| **契约 4: 资源冲突诊断** | 锁竞争冲突时输出清晰持有者与等待时长诊断 | 诊断日志断言 | PASSED |
| **契约 5: 不确定防重放** | `indeterminate` 状态在启动恢复时阻断自动重试 | 恢复测试断言 | PASSED |
| **契约 6: 崩溃恢复完整性** | 掉电模拟后，已提交 SQLite 事务的事实 100% 恢复 | 掉电回放测试 | PASSED |
| **契约 7: 缺少驱动明确报错** | 不支持的驱动能力直接抛出明确异常，绝不静默 | 异常类型测试 | PASSED |
| **契约 8: 工作流解耦一致性** | 替换工作流不改变内核生命周期跃迁规则与事件顺序 | 双装配行为对比单测 | PASSED |

---

## 2. Before / After 对比矩阵

| 维度 | 审查前 (Before) | 审查优化后 (After) |
|---|---|---|
| **断言规范** | 容易引入时钟毫秒数对比导致 Flaky 测试 | 严格比较状态规则、必要事件顺序与不变式 |
| **跨装配验证** | 仅有 xiocode 一套实现，无法证明内核通用性 | 两个独立消费者共用同一内核导出，严格证明零侵入 |
| **发行版装配** | 发行版工作流与内核底层耦合 | 发行版纯粹消费公开 API，三件套作为呈现层组件 |

---

## 3. 测试运行日志记录

```bash
$ pnpm exec vitest run tests/contract

 RUN  v5.0.1 /Users/xioshark/code/projects/xiocode

 ✓ tests/contract/headless-consumer.test.ts (8 tests) 331ms
 ✓ tests/contract/xiocode-consumer.test.ts (8 tests) 330ms

 Test Files  2 passed (2)
      Tests  16 passed (16)
   Start at  04:31:02
   Duration  849ms
```
