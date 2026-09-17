# PRD: 乐高组件宿主治理与 xiocode 默认三件套工作流 (Task 03)

## 1. 需求背景与定位

### 1.1 核心定位
- **归属**：`xiocode` 发行版装配层与默认扩展能力。
- **目标**：实现具备显式依赖声明、配置校验与可逆生命周期的组件宿主（`ComponentHub`）；构建 xiocode 默认三件套工作流组件与编程扩展积木，保持原文件换行符格式保真。

### 1.2 解决的关键缺陷
1. **生命周期设计简陋**：彻底摒弃简单的无生命周期 Map 存储，提供 `init(hub, config) -> start() -> dispose()` 标准生命周期，支持依赖拓扑解析与逆序安全清理；
2. **三件套定位纠正**：三件套（PRD / Todo / Verification）不再作为内核强制文件，而是作为 xiocode 的默认工作流工件组件，将内核执行事实同步为文档，负责业务状态机流转；
3. **换行符 Git Diff 污染**：精确编辑在匹配时自动容忍 CRLF / LF 差异，但**写回文件时必须保留原文件的换行符格式**，杜绝产生整文件的无用 Diff。

---

## 2. 核心功能与协议规范

### 2.1 组件宿主生命周期 (ComponentHub)
- `dependencies?: string[]`：声明前置依赖；
- `init(hub, config)`：注入依赖与读取白名单配置；
- `start()`：激活组件；
- `dispose()`：可逆副作用释放（注销事件、关闭文件句柄、清理资源）；
- 宿主关闭时按照依赖拓扑的逆序调用 `dispose`。

### 2.2 xiocode 默认三件套工作流组件 (ThreePieceWorkflowComponent)
- 在项目 `.xioflow/tasks/<task-id>/` 下创建并维护 `prd.md`、`todolist.md`、`verification.md`；
- 维护业务状态机：`Draft -> Ready -> In Progress -> Verified -> Archived`；
- 订阅内核事件，将真实的命令执行事实、耗时、退出码与证据路径原子写回 `verification.md`。

### 2.3 换行符严格保真的 ExactReplaceEditStrategy
- 读取目标文件时探测其原始换行符（`\r\n` 或 `\n`）；
- 匹配比对时统一归一化换行符寻找目标串；
- 校验目标串唯一性（非唯一或未找到显式报错抛出）；
- 替换内容格式化为原文件的换行符写回，保证 Git 差异精准。

---

## 3. 验收标准与交付物

1. **源代码交付（在 xiocode 仓库内）**：
   - `src/host/component-hub.ts`：具备依赖与生命周期的宿主；
   - `src/distribution/workflows/three-piece-workflow.ts`：三件套工作流组件；
   - `src/distribution/components/edit/exact-replace.ts`：换行符保真的精确替换策略；
   - `src/distribution/components/spec/rule-injector.ts`：规约扫描注入器；
   - `src/distribution/components/tools/kernel-tools.ts`：工具转 Operation 桥接器；
   - `src/distribution/components/safety/basic-interceptor.ts`：高危指令拦截器。
2. **测试验证**：
   - 组件生命周期正序启动与逆序清理单测；
   - CRLF 与 LF 混合文件编辑测试，验证原文件格式无污染；
   - 三件套工件生成与状态双向同步单测。
