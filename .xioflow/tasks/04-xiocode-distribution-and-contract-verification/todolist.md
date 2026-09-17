# Todolist: xiocode 最小发行版闭环与 8 项跨装配契约验收 (Task 04)

- [x] **步骤 1：实现无头 API 消费者契约测试**
  - [x] 在 `tests/contract/headless-consumer.test.ts` 中仅导入内核公开导出接口
  - [x] 编写 8 项跨装配一致性测试用例（状态规则、事件顺序、内核不变式）
  - [x] 确保断言不比较真实毫秒时间戳，仅比对逻辑状态与时序

- [x] **步骤 2：实现 xiocode 极简 Agent Loop**
  - [x] 在 `xiocode/src/runtime/agent-loop.ts` 中实现扁平循环
  - [x] 将模型生成的工具调用统一封装为内核 Operation 派发给内核执行
  - [x] 遇到工具执行失败原样回传，让模型自主闭环

- [x] **步骤 3：实现 xiocode 命令行 CLI**
  - [x] 在 `xiocode/src/cli/index.ts` 中暴露 `xio task` 与 `xio run`
  - [x] 接入进程退出信号拦截，调用内核安全停机流水线

- [x] **步骤 4：实现 xiocode 发行版消费者契约测试**
  - [x] 在 `tests/contract/xiocode-consumer.test.ts` 中装配发行版组件
  - [x] 共同运行 8 项一致性契约，验证更换三件套组件后内核行为完全一致
  - [x] 记录测试证据至 `verification.md`
