# Todolist: 乐高组件宿主治理与 xiocode 默认三件套工作流 (Task 03)

- [x] **步骤 1：实现组件宿主依赖与生命周期容器**
  - [x] 在 `xiocode/src/host/component-hub.ts` 中实现生命周期状态流转
  - [x] 实现拓扑依赖解析，按依赖顺序激活组件
  - [x] 实现宿主关闭时的逆序 `dispose()` 安全清理

- [x] **步骤 2：实现换行符保真的 ExactReplace 策略**
  - [x] 在 `xiocode/src/distribution/components/edit/exact-replace.ts` 中实现换行符探测（CRLF vs LF）
  - [x] 实现严格单处匹配检查，多匹配或未找到显式报错抛出
  - [x] 写回文件时恢复原换行符，杜绝全文件 Diff 污染

- [x] **步骤 3：实现 xiocode 默认三件套工作流组件**
  - [x] 在 `xiocode/src/distribution/workflows/three-piece-workflow.ts` 中管理三件套工件
  - [x] 映射业务工作流状态机（Draft -> Ready -> In Progress -> Verified -> Archived）
  - [x] 订阅内核执行事件，回填事实至 `verification.md`

- [x] **步骤 4：编写基础扩展积木**
  - [x] `rule-injector.ts`：扫描 `.xioflow/spec/` 按需注入规范
  - [x] `kernel-tools.ts`：将工具请求包装为内核受监督 Operation
  - [x] `basic-interceptor.ts`：高危命令判定与拦截策略

- [x] **步骤 5：单元测试与换行符保真验证**
  - [x] 编写 `xiocode/tests/distribution/workflow.test.ts`
  - [x] 验证包含 `\r\n` 的文件经编辑后换行符未被篡改为 `\n`
  - [x] 记录测试证据至 `verification.md`
