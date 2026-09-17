# Verification: 乐高组件宿主治理与 xiocode 默认三件套工作流 (Task 03)

## 1. 验证目标与判定矩阵

| 检验项 | 期望标准 | 验证手段 | 判定结果 |
|---|---|---|---|
| **生命周期逆序清理** | 宿主关闭时，被依赖组件晚于依赖组件释放 | 单元测试销毁时序断言 | PASSED |
| **换行符严格保真** | 编辑 CRLF 文件时，仅修改目标行，其余行的 `\r\n` 100% 保持不变 | 二进制/字符对比测试 | PASSED |
| **精准替换未命中** | 目标代码多于 1 处或未找到时，直接抛错，文件未被改动 | 精确替换断言测试 | PASSED |
| **三件套与内核解耦** | 移除三件套组件，内核仍可通过纯内存方式正常调度 | 隔离单测 | PASSED |

---

## 2. Before / After 对比矩阵

| 维度 | 审查前 (Before) | 审查优化后 (After) |
|---|---|---|
| **换行符处理** | 统一强转换行符，容易产生 Git 全量行 Diff 污染 | 内部归一化比对，写回严格保留原文件原有格式 |
| **组件生命周期** | 简单 Map 存储，无依赖声明与销毁机制 | 完整的注册、依赖拓扑装配、启动与逆序安全清理 (dispose) |
| **三件套归属** | 内核强制捆绑三件套，将 Markdown 解析作为终态判定依据 | 三件套是独立的发行版工作流组件，通过结构化事件回填工件 |

---

## 3. 测试运行日志记录

```bash
$ pnpm exec vitest run xiocode/tests/distribution/workflow.test.ts

 RUN  v5.0.1 /Users/xioshark/code/projects/xiocode

 ✓ xiocode/tests/distribution/workflow.test.ts (5 tests) 7ms
   ✓ Task 03: Component Hub & Default Three-Piece Workflow (5)
     ✓ 1. 组件宿主生命周期：按拓扑顺序初始化与逆序安全清理 1ms
     ✓ 2. 循环依赖检测：检测到环状依赖显式抛出 CircularDependencyError 1ms
     ✓ 3. 换行符保真的 ExactReplace：严格保留原文件换行符格式 2ms
     ✓ 4. 三件套工作流组件：管理工件与状态机流转 2ms
     ✓ 5. 基础安全拦截与规约注入积木 1ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  04:26:42
   Duration  112ms
```
