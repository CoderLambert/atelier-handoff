# 会话内子代理

主模型负责拆分任务、提交 brief、收集执行结果和最终答复。每次用户发送仍由一个顶层运行持有会话和项目执行槽。子代理使用独立上下文和相同的模型路由，继承本轮授权上限。每项任务可查看进度、工具、审批和结果。

## 依据与选择

[Agent SDK 子代理文档](https://code.claude.com/docs/en/agent-sdk/subagents)描述 `Options.agents`、`Agent` 和消息归属字段。锁定的 TypeScript SDK `0.3.326` 提供 `PreToolUse.agent_id`、参数重写、任务事件和独立停止控制。[官方示例的 `chat()`](https://github.com/anthropics/claude-agent-sdk-demos/blob/826b268506a5f3707623c9e6140b200befcbebae/research-agent/research_agent/agent.py)复用同一会话的代理定义。[Codex 的 `handle_spawn_agent`](https://github.com/openai/codex/blob/bb5b9c6240136de8ff4d30215e2341c44559aa04/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs)在宿主检查深度并登记子执行。工作台采用同样的宿主边界，工具归属使用调用身份和本轮授权校验。

选择 SDK 原生前台 `Agent`。锁定 CLI 2.1.326 的回环探针实际观察到两个子任务同时在途、逆序返回、任务 ID 对应子工具 hook 的 `agent_id`，以及 `PreToolUse.updatedInput` 的字段透传。运行时用该字段附加随机单次票据，执行器核对工具名和参数哈希后消费。任务结果从结构化 `Agent` 完成回调提取，按父轮与 SDK 调用身份分别记录。进程退出前关闭在途操作入口，保留已完成结果。

子任务角色为只读探索和本地执行。并发由原生 Claude SDK 调度。所有模型请求沿用该轮的网关和模型。子任务可使用本轮授权的站点搜索。共享浏览器、其他外部服务、整轮计划和成果发布由主会话操作。

同项目内可能冲突的写入和命令串行执行，审批等待不占写入锁。提交前复核基线和实时权限。运行时持有状态和取消信号，SQLite 存储子任务与工具关联，renderer 读取快照和增量通知。重启后保留工具效果并将未终结任务标为中断。任务恢复由主会话基于可见结果重新判断。

## 验证与回退

在隔离工作区验证同参工具调用、部分拒绝、两个陈旧差异的竞争、取消和异常恢复。真实 SDK 的回环夹具检验协议行为。真实模型经获得授权的本机网关验证自然语言主动委派。可关闭委派工具保留原会话执行路径和历史记录，数据库升级沿用一致性备份流程。
