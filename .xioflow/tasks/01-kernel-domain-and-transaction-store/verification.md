# Verification: 执行域所有权、SQLite 事务存储与意图登记协议 (Task 01)

## 1. 验证目标与判定矩阵

| 检验项 | 期望标准 | 验证手段 | 判定结果 |
|---|---|---|---|
| **域所有权互斥** | 第二个进程尝试获取已被占用的执行域时，明确抛出错误 | 多进程并发争抢单测 | PASSED |
| **事务原子提交** | 事件落盘与状态流转处于同一事务，失败自动回滚 | 故障注入异常回滚测试 | PASSED |
| **序号严格单调** | `seq` 在域内严格连续自增，绝无重复或倒退 | 连续并发写入断言 | PASSED |
| **意图先于动作** | Operation 必须先进入 `intent_registered` 状态方可被外部读取 | 数据库事务时序检查 | PASSED |
| **隔离重建有效** | 数据库中处于未终结状态的资源在启动时即被锁定 | 重启加载状态断言 | PASSED |

---

## 2. Before / After 对比矩阵

| 维度 | 审查前 (Before) | 审查优化后 (After) |
|---|---|---|
| **存储介质** | 自研 JSONL 纯文本追加，断电容易损坏文件 | 嵌入式 SQLite 事务存储，配置 WAL + FULL 同步 |
| **管理边界** | 整机统一与工作区边界模糊，硬编码路径 | 明确 Execution Domain 抽象，单域单活动所有者 |
| **启动时序** | 先启动进程后写日志，容易产生孤儿进程 | 先在事务中持久化意图与资源占用，再请求驱动 |

---

## 3. 测试运行日志记录

```bash
$ pnpm exec vitest run xioflow/packages/kernel/tests/store/sqlite.test.ts

 RUN  v5.0.1 /Users/xioshark/code/projects/xiocode

 ✓ xioflow/packages/kernel/tests/store/sqlite.test.ts (5 tests) 18ms
   ✓ Task 01: ExecutionDomain & SQLite Transactional Store (5)
     ✓ 1. 域所有权互斥：同一域禁止双重获取 5ms
     ✓ 2. 事务原子提交与回滚：失败时不残留脏数据 3ms
     ✓ 3. 序号严格连续单调自增 3ms
     ✓ 4. 意图先于动作协议：落盘 intent_registered 与持久化资源租约 3ms
     ✓ 5. 启动先建隔离协议：重启时从持久化存储重建资源锁 4ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  04:23:54
   Duration  120ms
```
