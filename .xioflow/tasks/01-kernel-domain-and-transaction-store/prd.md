# PRD: 执行域所有权、SQLite 事务存储与意图登记协议 (Task 01)

## 1. 需求背景与定位

### 1.1 核心定位
- **归属**：`xioflow` 共享内核公共能力。
- **目标**：实现默认工作区级的**执行域（Execution Domain）**抽象与 **SQLite 事务存储**，提供掉电级一致性保证；实现先登记意图再启动操作的协议基座。

### 1.2 解决的关键缺陷
1. **整机混战与路径硬编码**：过去未明确管理范围。本任务确立执行域模型，同一工作区对应单一执行域与唯一活动所有者，多 Worktree 共享 Git 元数据，不硬编码 `.xioflow/`；
2. **纯文本追加日志脆弱**：自研 JSONL 追加在发生系统崩溃或断电时极易产生半截损坏或刷盘错序。采用嵌入式 SQLite（`WAL + synchronous=FULL`，macOS `F_FULLFSYNC`）实现控制状态、资源租约与带自增序号的 Journal 事件原子提交；
3. **未登记即执行的盲区**：过去先调用驱动再记录日志，进程启动后崩溃导致孤儿失联。本任务落实启动协议第一步：**先在事务中持久化操作意图与资源占用，再请求驱动**。

---

## 2. 核心功能与数据模型

### 2.1 执行域所有权 (Execution Domain Lock)
- `ExecutionDomain.acquire(domainPath)`：通过文件锁获得执行域唯一所有权；若已被其他所有者持有，抛出明确错误；
- 初始化嵌入式数据库连接（`domain.db`），配置 `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`。

### 2.2 数据库 Schema 与原子事务
包含核心表结构：
1. `tasks`：逻辑工作单元（`id`, `domain_id`, `name`, `created_at`, `meta`）；
2. `runs`：执行尝试（`id`, `task_id`, `owner`, `status`, `termination_reason`, `started_at`, `ended_at`, `config_snapshot`）；
3. `operations`：受管操作（`id`, `run_id`, `name`, `kind`, `input_fingerprint`, `status`, `required_resources`）；
4. `resource_leases`：持久化资源占用（`resource_id`, `operation_id`, `acquired_at`）；
5. `journal_events`：带自增序号（`seq`）的领域事件日志，与状态变更在同一事务内提交。

### 2.3 启动与恢复协议基座
1. **意图先于动作 (Intent-First)**：
   `registerOperationIntent(op)` 在独立事务中完成 `operations`（状态 `intent_registered`）与 `resource_leases` 的写入；
2. **启动先建隔离 (Recovery-Before-Execution)**：
   `ExecutionDomain.open()` 时，首先扫描 `operations` 中未终结记录，将其 `required_resources` 重新加载进内存隔离表，阻断冲突操作申请。

---

## 3. 验收标准与交付物

1. **源代码交付（在 xioflow 仓库内）**：
   - `packages/kernel/src/domain.ts`：执行域所有权管理；
   - `packages/kernel/src/store/sqlite.ts`：SQLite 事务封装与 WAL/FULL 配置；
   - `packages/kernel/src/store/schema.ts`：表结构定义与迁移；
   - `packages/kernel/src/types.ts`：内核实体类型契约。
2. **测试验证**：
   - 模拟进程并发获取同一执行域，验证互斥排他锁与错误诊断；
   - 验证操作意图与资源占用原子提交到 SQLite；
   - 验证单调序号严格连续递增与事务一致性。
