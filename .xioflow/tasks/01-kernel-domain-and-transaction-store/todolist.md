# Todolist: 执行域所有权、SQLite 事务存储与意图登记协议 (Task 01)

- [x] **步骤 1：定义执行域与存储契约**
  - [x] 在 `packages/kernel/src/types.ts` 中定义 `Task`、`Run`、`Operation`、`KernelRunStatus`、`TerminationReason`
  - [x] 确保 `config_snapshot` 仅包含白名单配置，严禁敏感 Token 序列化落盘

- [x] **步骤 2：实现基于文件排他锁的执行域所有权管理器**
  - [x] 在 `packages/kernel/src/domain.ts` 中实现 `ExecutionDomain.acquire`
  - [x] 确保同域互斥，记录所有者元数据（持有者 PID、获取时间）

- [x] **步骤 3：实现 SQLite 事务存储层**
  - [x] 在 `packages/kernel/src/store/schema.ts` 中定义 DDL（tasks, runs, operations, resource_leases, journal_events）
  - [x] 在 `packages/kernel/src/store/sqlite.ts` 中配置 `WAL + synchronous=FULL` 与 macOS `F_FULLFSYNC`
  - [x] 实现 `recordEventAndTransitionState` 原子提交方法，保障单调序号自增

- [x] **步骤 4：实现操作意图登记与启动隔离重建**
  - [x] 实现 `registerOperationIntent(op)`：在独立事务中落盘状态 `intent_registered` 与资源占用
  - [x] 实现 `rebuildIsolationFromStore()`：启动时直接读取未终结操作的资源并锁定

- [x] **步骤 5：单元测试与事务持久性验证**
  - [x] 编写 `packages/kernel/tests/store/sqlite.test.ts`
  - [x] 测试并发锁竞争抛错、事务回滚一致性与单调序号连续性
  - [x] 记录测试结果至 `verification.md`
