# XioCode 架构：产品如何装配在 xioflow 内核上

> 本文只写 **xiocode 怎样使用内核**。内核自身的协议、契约与状态机以内核仓为唯一权威：
> [`Xio-Shark/xioflow` → ARCHITECTURE.md](https://github.com/Xio-Shark/xioflow/blob/main/ARCHITECTURE.md)。
> 这里此前是一份内核规范的旧拷贝（四协议、八契约、`stopped: boolean`、`accurateStartTime`），
> 与 0.2.0 起的实际 API 不一致，已删除，避免出现第二份真相源。

依赖版本：`@xioflow/kernel` 0.5.0。代码入口：`src/runtime/process/`（内核会话与进程执行）、
`src/runtime/kernel-binding.ts`（会话层接线）、`extensions/xio-sandbox/src/direct-gate.ts`（回滚）、
`extensions/xio-hygiene/src/kernel-stdio-transport.ts`（MCP）。

---

## 1. 对象映射

| xiocode | 内核 | 说明 |
|---|---|---|
| 一个会话（session id） | 一个执行域 + 一个 Task | 域目录 `<XIO_HOME>/kernel/<workspace>-<digest>-s<session digest>`；`XIOCODE_KERNEL_DOMAIN_ROOT` 可覆盖根目录 |
| 一次启动 | launch Run | turn 之外的操作（MCP service、斜杠命令触发的进程）归它；退出时收尾 |
| 一次用户 prompt（turn） | 一个 Run | `beginTurn` / `endTurn`，按完成协议上报 succeeded / failed / cancelled |
| done-contract 结论 | `XIOCODE_ACCEPTANCE` journal 事实 | 验收失败让 Run 记为 failed，执行事实与业务验收分开 |
| 一条受监督命令 | 一个 process Operation | bash、done-contract、搜索后端、plan dispatch、sandbox 的 git 调用 |
| 一个 MCP stdio server | 一个 service Operation（`svc-…#n`） | `restart: never`；journal 里只记命令形状，不记 env / 参数值 |
| 一次权限决策 | `XIOCODE_AUTHORIZATION` journal 事实 | 主语只存指纹；带 toolCallId，可与随后的操作对上 |
| tool call id → 操作 | `XIOCODE_TOOL_OPERATION` journal 事实 | resume 按它查中断调用的真实结果 |
| direct 模式的会话基线 / 每轮检查点 | 内核快照（git-shadow） | WAL checkpoint 记录 `snapshot_id` 与 `journal_seq` |
| 回退点（每轮开始） | 该轮检查点快照 + `XIOCODE_REWIND_POINT` journal 事实 | 事实记快照 id、轮前消息数、prompt 指纹；`XIOCODE_REWIND` 记一次回退并截断之后的点 |

**为什么 opId 不用 tool call id**：provider 返回的 tool call id 不保证会话内唯一（有的按响应编号 `call_0`）。
opId 在域内唯一（D17），同 opId 同输入会被 0.3.0 幂等协议回放，因此复用 id 会让一条新命令拿到旧结果而不执行。
xiocode 让每次执行的 opId 唯一，用 journal 事实记录 `toolCallId → opId`。

## 2. 开关

- **内核会话**始终开启：它只需要 `node:sqlite`（Node ≥ 22.13，与 `engines` 一致）和 git。
  打不开时（例如域目录不可写）会话照常工作，但会一次性提示：direct 模式回滚与 journal 关闭，命令与 MCP 不经内核。
- **进程执行器**默认是内核。`XIOCODE_PROCESS_KERNEL=0`（或内核驱动不支持的平台）改用内置 supervisor，
  只影响命令与 MCP stdio 的执行方式。这个逃生开关计划在 2.0 删除，前提是 0.4.0 接入后的观察期通过。
- **平台驱动**：`XIOCODE_KERNEL_DRIVER=auto`（默认）在内核包带有本平台 native reaper 时用 `ReaperPlatformDriver`
  （持有整棵进程树，`setsid` 逃逸者也能停掉），否则用 `NodePlatformDriver`；`node` / `reaper` 强制指定，
  `reaper` 在缺 helper 的平台直接报错。实际选择与原因显示在 `/kernel`。恢复与孤儿域清扫用同一选择。

## 3. 资源仲裁

- 写型操作声明 `workspace:write:<workspaceRoot>`（cwd 在工作区外时用 cwd 本身），读型操作不申请租约。
  bash 按 command-risk 的「已证明安全」白名单分类，其余一律算写；搜索后端是读；git 按子命令分类。
- 写者之间 FIFO 排队，最多等 15 分钟；排过队的结果会写明排在谁后面。持有者是 indeterminate 操作时立即拒绝，并给出裁决命令。
- 快照与回滚占用同一个租约，所以回滚不会在写命令运行时发生，也不会越过未裁决的操作。
- **边界**：执行域是单写者（一个进程拥有），所以租约只在会话内仲裁。不同会话是不同的域；
  worktree 模式下各会话本来就各自隔离，direct 模式下两个会话同写一个目录不在内核仲裁范围内。

## 4. 崩溃恢复与用户出口

1. 打开会话时先对自己的域跑 `RecoveryEngine`（在创建新 Run 之前），收敛上次启动遗留的 Run 与操作，结果显示给用户。
2. 后台清扫 owner 进程已死亡的其他域（锁文件在、pid 已不存在；活着的 owner 一律不碰，即使租约过期）。
3. indeterminate 的出口：会话内 `/kernel`、`/kernel adjudicate <opId>`；会话外 `xio kernel status`、`xio kernel adjudicate <opId> [--domain]`。
   域被活着的会话占用时，CLI 会指向会话内命令。
4. resume：中断的工具调用按 `XIOCODE_TOOL_OPERATION` 查内核事实，回填「未启动 / 已完成（退出码与输出尾部）/ 仍未确认」。不自动重放。

## 5. 回滚诚实性

direct 模式的回滚结果如实呈现内核结论：`restored` / `partial`（列出未恢复路径）/ `failed`（抛错）；
快照不含被忽略文件；自检查点以来若有未受写入限制的命令运行（`outOfScopeEffects: possible`），会提示工作区外可能留有副作用。
xiocode 目前不启用写入限制驱动（sandbox-exec / bubblewrap），因此 `coverage` 不会是 `complete`。

保留策略：会话基线 + 最近 20 轮的轮前快照（回退点）；更早的在新 turn 开始时回收。会话启动时只保留 journal 里仍列出的回退点快照，
其余之前启动留下的快照回收；删除会话时一并清理。

### 回退（Esc Esc / `/rewind`）

回到某一轮开始前：文件（该轮的轮前快照，经内核回滚并核验）、对话（截断到该轮 prompt 之前，prompt 放回输入框），或两者。
- 回退点在自动压缩之后、该轮 prompt 进入历史之前记录，所以消息数对应模型真正看到的对话；
- 回退点作为 journal 事实持久化，resume 后仍可列出；快照已回收的点不能恢复文件，压缩后 prompt 已不在原位置的点不能恢复对话，两者都写明原因，不猜；
- 文件 + 对话回退会丢弃该轮及之后的回退点与快照；只回退文件保留对话里的回退点；只能在空闲时进行。
- worktree 模式没有内核快照，只提供对话回退。

## 6. 有意没有接入内核的部分

| 部分 | 原因 |
|---|---|
| worktree 沙盒的创建 | 沙盒要一个从 baseRef 分出的分支和完整历史，供 MergeGate 合并与 agent 使用 `git log`；内核 `materialize` 产出的是基于快照、无父提交的 detached worktree。沙盒内的 git 调用本身走内核。 |
| speculative racing | 引擎未接入默认 agent loop（`/race` 只报告状态），在它成为可达功能之前不改造。 |
| `project-trust` 的 git 调用 | 启动阶段同步计算信任指纹（`spawnSync`），发生在会话与内核绑定之前。 |

## 7. 相关文档

- 内核规范：xioflow 仓 `ARCHITECTURE.md`（权威）
- 产品目标：[docs/GOAL.md](./docs/GOAL.md)；交付状态：[docs/STATUS.md](./docs/STATUS.md)
