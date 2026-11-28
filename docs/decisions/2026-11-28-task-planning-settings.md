# 工作台按需显示任务清单

## 问题与范围

基线 `1076452` 对有规划能力的运行统一提供工具，受控提示和原生预设分别拼接固定规则。按批准的方案，在设置中提供自动、仅在我要求时、关闭三档，支持按模型覆盖和编辑拆分提示词。保存从下一次创建运行起生效。聊天和计划任务共用已有运行入口，独立提示词增强和 Git 文本生成沿用各自入口。

## 查阅与取舍

- [Claude Agent SDK 任务工具可用性](https://code.claude.com/docs/en/agent-sdk/todo-tracking#model-availability) 说明 SDK 可按次配置内置工具，`CLAUDE_CODE_ENABLE_TASKS=0` 选整表 `TodoWrite`。采用项目锁定的 SDK 0.3.332 与 CLI 2.1.332 实测工具集合和成功回执。
- [Gemini CLI write-todos.ts](https://github.com/google-gemini/gemini-cli/blob/60f8082b14ffa7f10b608270232f3f57b5abbec8/packages/core/src/tools/write-todos.ts) 的 `WriteTodosTool` 校验参数并整表替换，适合沿用工作台已有的 `Run.plan`。按 [Codex Plan Mode 模板](https://github.com/openai/codex/blob/6bfc58a688a73c287da51797d99c3345caecbae8/codex-rs/collaboration-mode-templates/templates/plan.md) 区分正式评审方案与运行中清单。本次采用前者的整表更新形式和后者的明确完成条件。
- 将设置放入已有 SQLite 设置表的独立版本键，缺省自动。合并 PATCH 以短事务保存，每个运行按实际选择的路由模型 ID 解析策略。实测 SDK 默认记录系统提示，续接时会复用旧提示。采用锁定 SDK `Options.systemPrompt` 声明提供的 `snapshot: false`，每次创建 SDK 查询时渲染本轮系统提示。工作台的配置快照在本轮固定，续接时保留原 SDK 对话和工具证据。
- 工具权限先于展示偏好。关闭时移除两条清单工具路径，并在写入处复核。工作台和 SDK 整表工具共用条目校验、原子落库和事件发布。用户编辑的提示词只影响拆分，模式约束与交付验收由运行时持有。当前执行模型识别是否建清单，无分类或规划模型的额外请求。

## 验证和回退

使用临时 SQLite、真实 SDK 和回环替身验证工具可用性、事件与历史，隔离 Linux Electron 验证中文及英文流程。对照基线以同一本地模型复跑六个既有样例并记下实际交付、请求数、token 和耗时。回退到 `1076452` 即恢复原行为，设置键为独立 JSON，历史运行的清单格式一致，回退无需修改数据库。
