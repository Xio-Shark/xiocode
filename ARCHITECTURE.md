# xioflow 内核与 xiocode 发行版架构与协议规范

> **状态**：正式实施基准规范（协议细化与事务可恢复版）  
> **核心定位**：  
> - **xioflow**：面向 Agent 应用的受监督执行内核。提供执行域管理、受监督操作、资源仲裁、停止确认、SQLite 事务持久化与崩溃恢复机制；无 UI 绑定，不绑定特定 Agent Loop 或文件格式。  
> - **xiocode**：基于 xioflow 装配的编程发行版。提供模型接入、编程工具、默认三件套工作流（PRD / Todo / Verification）、安全策略及 CLI/TUI。  
> **仓库分工**：xioflow 作为独立共享内核仓库/模块开发；xiocode 作为独立发行版仓库，通过公开导出接口消费内核。

---

## 0. 核心定位与设计决策

### 0.1 Linux 范式与边界划界

| 关注维度 | xioflow 内核负责 | xiocode 等发行版负责 |
|---|---|---|
| **管理范围** | 执行域（Execution Domain）生命周期、域内唯一所有者 | 决定按工作区、按项目还是按会话绑定执行域 |
| **任务执行** | Run 尝试分配、执行状态跟踪、受管 Operation 归属 | 怎样拆分任务、采用何种业务工作流与工件 |
| **并发编排** | 资源配额仲裁、等待依赖、取消作用域 | 串行队列、DAG 拓扑、并行候选等具体编排算法 |
| **进程管理** | 平台驱动抽象、监督协议、停止确认、事实记录 | 选择要运行的工具、传递何种命令与参数 |
| **权限安全** | 按授权范围检查受管操作，审计记录决策事实 | 人工交互提问、风险分级与交互策略配置 |
| **验证判定** | 保存可信执行事实（状态、输出证据、产物引用） | 判定什么测试输出算业务验收通过 |
| **崩溃恢复** | 启动前现场重建、冲突资源隔离、Journal 事务恢复 | 决策哪些失败允许修复、重试或重新规划 |
| **模型上下文** | 完全不处理模型上下文、自然语言与提示词 | 提示词片段拼装、规约按需注入、会话裁剪 |
| **界面与工件** | 零 UI 依赖、不强制任何特定 Markdown 文件 | CLI、TUI、三件套文档及其他呈现形式 |

### 0.2 两项核心架构裁决

#### 1. 管理范围：默认工作区级执行域，不做整机统一调度
- **执行域（Execution Domain）定义**：一个执行域拥有一份持久化 SQLite 状态库、一个活动内核所有者（Active Kernel Owner）、一套资源登记，以及域内有序的事务事件记录；
- **单域单所有者**：同一执行域同一时刻只有一个活动内核所有者进程，通过文件排他锁与租约维系；
- **域边界说明**：
  - 序号仅在域内连续递增，不要求整机统一；
  - 同一代码仓库的多个 Git Worktree 需识别共享的 `.git` 元数据资源归属，防止并发操作 Git 索引破坏仓库；
  - 域内资源登记无法控制域外非受管程序（若外部程序抢占端口，由操作系统真实错误暴露，内核不虚构整机绝对隔离保证）。

#### 2. 异常影响范围：冻结冲突资源，允许已证明独立的运行继续
严格区分**“结果不确定”**与**“进程可能仍存活”**两个正交维度：
- **操作执行者可能仍在运行**：严格隔离其可能占用的冲突资源，禁止将其分配给新操作；
- **操作已确认停止，但副作用结果未知**：阻断盲目重放，保留现场，由恢复程序核验；
- **已证明没有资源或成果依赖的其他运行**：允许继续执行，不搞一刀切全盘挂起；
- **无法确定影响范围时**：保守暂停整个执行域的新操作；
- **发行版策略**：发行版可根据产品偏好选择更保守的全局暂停，但绝对不能放宽内核的强制隔离。

---

## 1. 持久化架构与掉电保证 (SQLite Transactional Store)

为实现系统断电级崩溃恢复，内核控制状态放弃易损坏的自研纯文本追加，统一采用 **嵌入式 SQLite 事务存储**。

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Execution Domain 存储边界                       │
│                                                                        │
│   SQLite Database (domain.db)                                          │
│   ├── tasks / runs / operations (状态表)                               │
│   ├── resource_leases (持久化资源占用表)                                │
│   └── journal_events (带单调自增序号的事件日志)                         │
│                                                                        │
│   WAL 模式 + PRAGMA synchronous = FULL / macOS F_FULLFSYNC             │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.1 三种持久化保证的明确界定
1. **控制事实持久化**：已确认提交的 Run 状态、Operation 启动意图、授权决策与结果，在事务提交（`commit`）后经 `FULL` 刷盘保证，掉电后 100% 可恢复；
2. **受管产物持久化**：内核确认“产物已保存”前，产物驱动必须调用 `fsync` 完成物理刷盘，而非仅仅返回路径；
3. **外部副作用状态**：外部 Shell 命令执行、远程 API 调用无法纳入本地 DB 事务。内核在外部调用前后设置**前置意图登记**与**后置结果核验**窗口，不确定现场强制进入恢复流水线。

> **掉电保证承诺边界**：在声明支持的本地文件系统（如 APFS、ext4）和正确履行同步语义的硬件存储设备上，保证已确认提交的内核事实及受管产物可恢复；不包含物理硬件损毁或设备虚报刷盘完成。

---

## 2. 核心领域模型与实体契约 (TypeScript)

```typescript
/**
 * 逻辑工作单元
 */
export interface Task {
  id: string;                      // 任务唯一标识
  domainId: string;                // 所属执行域
  name: string;
  createdAt: string;               // ISO8601
  meta?: Record<string, unknown>;  // 发行版元数据
}

/**
 * 单次执行尝试
 */
export interface Run {
  id: string;
  taskId: string;
  domainId: string;
  owner: string;                   // 执行所有者（session-id / agent-runner）
  status: KernelRunStatus;
  terminationReason?: TerminationReason;
  startedAt: string;
  endedAt?: string;
  configSnapshotWhiteList?: Record<string, unknown>; // 白名单安全配置快照
}

export type KernelRunStatus =
  | 'queued'        // 已排队
  | 'starting'      // 正在启动准备
  | 'running'       // 正常执行中
  | 'stopping'      // 停止中，等待底层驱动确认
  | 'succeeded'     // 成功收尾（所有操作已结清）
  | 'failed'        // 显式执行失败
  | 'cancelled'     // 已确认停止
  | 'indeterminate';// 结果不确定（无法确认是否停止或副作用未明）

export type TerminationReason = 
  | 'completed'
  | 'user_cancelled'
  | 'timed_out'
  | 'resource_preempted'
  | 'crash_detected';

/**
 * 受监督原子操作
 */
export interface Operation {
  id: string;
  runId: string;
  kind: 'process' | 'filesystem' | 'gate' | 'custom';
  name: string;
  inputFingerprint: string;        // 输入与配置哈希指纹
  requiredResources: string[];     // 申请占用的资源（如 ["workspace:write:root"]）
  timeoutMs?: number;
  status: 'pending' | 'intent_registered' | 'active' | 'stopping' | 'done';
}

/**
 * 多态执行结果
 */
export type OperationResult =
  | ProcessOperationResult
  | FilesystemOperationResult
  | GenericOperationResult
  | IndeterminateResult;

export interface BaseResult {
  durationMs: number;
  completedAt: string;
}

export interface ProcessOperationResult extends BaseResult {
  kind: 'process';
  status: 'succeeded' | 'failed' | 'cancelled';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  isTruncated: boolean;            // 标记输出是否达到有界上限被截断
  identityVerification: IdentityVerificationResult;
}

export interface FilesystemOperationResult extends BaseResult {
  kind: 'filesystem';
  status: 'succeeded' | 'failed';
  targetPath: string;
  action: 'create' | 'modify' | 'delete';
  bytesWritten?: number;
  errorMessage?: string;
}

export interface GenericOperationResult extends BaseResult {
  kind: 'generic';
  status: 'succeeded' | 'failed' | 'cancelled';
  outputRef?: string;              // 不可变产物引用
  errorMessage?: string;
}

export interface IndeterminateResult extends BaseResult {
  kind: 'indeterminate';
  status: 'indeterminate';
  reason: string;                  // 未知原因
  recoveryGuidance: string;        // 人工恢复或现场排查指引
}

export type IdentityVerificationResult =
  | 'is_original_process'          // 确认为原启动进程
  | 'not_original_process'         // 确定已不是原进程
  | 'cannot_determine';            // 无法可靠判断
```

---

## 3. 四大核心运行协议 (Formal Protocols)

### 3.1 启动协议：先登记意图，再执行 (Intent-First Spawn Protocol)
杜绝“启动了进程却无记录”的崩溃盲区：

```text
1. [事务提交] 在 SQLite 中写入 Operation 意图、输入指纹与资源占用 (status: intent_registered)
   └── 崩溃判定：若此时崩溃，重启时发现此状态且无进程身份，安全清理资源，判定为未启动。
2. [驱动调用] 调用 PlatformDriver.spawn(command)
   └── 获得底层进程执行身份 ProcessIdentity (pid, startTimeMonotonic)
3. [事务提交] 更新 Operation 记录执行身份并推进为 'active' (status: active)
   └── 崩溃判定：若在此步之间崩溃，重启恢复时凭登记的输入意图与驱动比对，进入核验。
4. [正常监督] 挂载实时流排空泵、注册超时定时器与退出监听
5. [驱动终止] 进程结束或触发停止，驱动产出初步结果
6. [事务提交] 原子写入 OperationResult 并根据确认事实释放相关资源占用
```

### 3.2 资源恢复协议：先建隔离，再开新操作 (Recovery-Before-Execution Protocol)
启动内核时，严禁先接收新操作再慢悠悠恢复：

```text
1. [获取所有权] 尝试获取执行域 SQLite 文件排他锁；失败则抛出 DomainLockedError
2. [加载未终结状态] 从数据库加载所有处于 'active'、'stopping'、'intent_registered' 的 Run 与 Operation
3. [重建隔离屏障] 将所有未结清操作声明的 requiredResources 立即载入内存隔离表，阻止任何新操作申请
4. [驱动现场核查]：
   ├── 核对进程身份 (verifyIdentity)：
   │   ├── is_original_process: 发送停止流水线，推进至安全终态
   │   ├── not_original_process: 进程已死，核对产物并结清资源
   │   └── cannot_determine: 标记为 indeterminate，保留隔离屏障，禁止分配
   └── 核对受管文件修改现场（校验输入指纹与后置条件）
5. [开放安全操作] 仅对已确认没有资源冲突且与未终结操作无关的独立运行开放执行
```

### 3.3 Run 完成协议：业务修复与执行事实分开 (Run Completion Protocol)
在实际编程场景中，测试报错 -> 修复代码 -> 测试通过是正常回路，内核不能因为中间有失败操作就强行将 Run 标死，但也不能只看最后一次成功而掩盖错误。

#### 内核 Run 结束条件判定表

| 检查项 | 必须满足的内核条件 | 不满足时的处理 |
|---|---|---|
| **操作收尾** | 该 Run 下所有发起的 Operation 均已达到终态（无 `active`/`stopping`） | 阻断 Run 结束，等待底层收尾 |
| **资源结清** | 该 Run 占用的临时排他资源已安全释放 | 保持 Run 活跃，进行资源清理 |
| **无悬挂不确定态** | 关键操作不存在未裁决的 `indeterminate` 状态 | 标记 Run 为 `indeterminate` 并报警 |
| **业务验收结论** | 发行版显式提交 `reportRunSucceeded()` 或 `reportRunFailed()` | 内核仅确认执行事实完整，不自行猜测业务对错 |

> **重要规则**：内核中的 `Run.status = succeeded` 仅表示“该执行尝试在内核受管协议下已完整合法收尾”，**不代表该任务的所有业务需求在逻辑上必然完全正确**（业务验收由发行版自行断言）。

### 3.4 恢复协议：凭证后置条件关联，不凭存在猜成功
恢复已崩溃的操作时，严禁因为“目标文件存在”或“Git 有个 commit”就盲目推断为成功：

```text
恢复验证链路：
[Operation 记录] ──> [输入与配置指纹一致性] ──> [执行凭证(Transaction ID/日志签名)] ──> [驱动验证后置条件]
                                                                                            │
                                                                   ┌────────────────────────┴────────────────────────┐
                                                                   ▼ 全部吻合                                         ▼ 缺失或存疑
                                                            提交 Succeeded                                    提交 Indeterminate
```

---

## 4. 平台驱动契约与停止确认流水线

### 4.1 平台驱动能力与停止范围抽象

```typescript
export interface PlatformDriver {
  name: string;
  capabilities: {
    processGroupKill: boolean;     // 是否支持杀死整个进程组 (PGID)
    accurateStartTime: boolean;    // 是否支持微秒级系统进程创建时钟核验
  };
  spawn(command: StructuredCommand): Promise<ManagedProcessHandle>;
  verifyIdentity(identity: ProcessIdentity): Promise<IdentityVerificationResult>;
  terminate(identity: ProcessIdentity, graceMs: number): Promise<StopProcessResult>;
}

export interface StopProcessResult {
  stopped: boolean;                // 是否确认完全停止
  scope: 'direct_child' | 'process_group' | 'unknown';
  residualPids?: number[];         // 存疑的残留进程 PID
  errorDetails?: string;
}

export interface StructuredCommand {
  execPath: string;
  args: string[];
  cwd: string;
  envWhiteList?: Record<string, string>; // 严格白名单环境变量，绝不落盘全量 env
}

export interface ProcessIdentity {
  pid: number;
  startTimeMonotonic?: number;     // 单调系统启动时间
  spawnTime: string;
}
```

### 4.2 停止确认流水线 (Stopping Pipeline)
```text
取消/超时触发
 └──> Run 状态进入 'stopping'（锁定冲突资源，拒绝新子操作）
       └──> 驱动向目标发送优雅中断信号 (SIGINT)
             └──> 启动受控宽限期计时器 graceMs (如 3000ms)
                   └──> 仍未退出？调用驱动发送 SIGTERM / SIGKILL
                         └──> 调用驱动核对 StopProcessResult
                               ├── stopped === true -> 记录 'cancelled' 或 'timed_out' -> 释放资源
                               └── stopped === false -> 记录 'indeterminate' -> 保留隔离并报警
```

### 4.3 有界输出排空与截断机制
- 内存保留缓冲上限默认 10MB；
- 超出上限后，设置 `isTruncated = true`，停止累加内存，但**必须持续保持 stream.on('data') 读取排空**，防止 OS 内核管道填满（通常 64KB）导致子进程永久死锁；
- 等待 stdio 完全关闭设置有界排空超时（默认 2000ms），超时后强制记录并结束，防止持有句柄的孤儿后代进程导致主进程无限卡死。

---

## 5. 发行版装配与 xiocode 编程工作流

xiocode 作为编程发行版，装配具体工作流组件与编程工具：

```text
xiocode 发行版
 ├── 默认工作流组件 (ThreePieceWorkflowComponent)
 │    ├── 管理 .xioflow/tasks/<task-id>/ 三件套 Markdown (PRD / Todo / Verification)
 │    └── 维护业务状态机 (Draft -> Ready -> In Progress -> Verified -> Archived)
 ├── 编程乐高积木
 │    ├── ExactReplaceEditStrategy: 精确子串匹配，保留原文件换行符格式，未命中严格抛错
 │    ├── RuleSpecInjector: 扫描 .xioflow/spec/ 规约注入上下文
 │    ├── KernelTools: 将工具请求转为内核 Operation
 │    └── SafetyInterceptor: 高危操作拦截与人工确认
 └── 终端运行环境
      ├── 极简 Agent Loop (Pi 范式)
      └── 命令行 CLI (xio task / xio run)
```

### 换行符严格保真原则
`ExactReplaceEditStrategy` 在做子串匹配时，内部逻辑可将 CRLF 与 LF 统一解析比对；但**写回文件时必须遵循原文件的原有换行符格式**，严禁在无意中将整个文件的所有行批量变更为另一种换行符，避免污染 Git Diff。

---

## 6. 八项跨装配一致性契约测试

为严格证明 xioflow 共享内核的独立性与可靠性，项目实现**无头 API 消费者**与**xiocode 发行版**共同运行的 8 项一致性契约测试：

1. **错误命令启动**：启动不存在的程序立即返回失败，绝不产生假运行状态（No Fake Running）；
2. **大输出有界排空**：产生 50MB 日志子进程顺畅退出，缓冲区排空，标记 `isTruncated = true`；
3. **未确认停止锁保留**：进程处于 `stopping` 未确认退出时，其申请的排他资源绝对不被释放；
4. **资源冲突可诊断**：两个 Operation 争抢同一资源，后发起者排队并输出持有者与等待时长诊断；
5. **不确定副作用防重放**：`indeterminate` 状态的操作在启动恢复时阻断自动重试，强制等待人工处理；
6. **崩溃可靠恢复**：模拟掉电崩溃，已提交 SQLite 事务的事实在重启后 100% 完整重现；
7. **平台驱动能力缺失显式失败**：不支持的平台驱动能力显式暴露，绝不静默降级或伪造成功；
8. **工作流无感替换**：将三件套 Markdown 工作流替换为纯内存工作流，内核的 `KernelRunStatus` 状态跃迁规则与事件时序逻辑完全一致。
