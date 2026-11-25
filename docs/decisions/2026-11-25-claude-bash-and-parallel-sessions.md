# Claude CLI 的 Bash 生命周期和同目录会话

旧版禁用了 Claude 后台任务，并在收到首个模型终态时关闭 SDK。旧执行席位也会拒绝同一目录的独立会话。这两处分别影响长命令期间的调控和同目录切换会话。

## 决策

- 本机信任采用锁定 Claude Agent SDK 0.3.332 与内置 CLI 2.1.332 的 Bash 执行和时限。普通兼容消息在工具检查点发送。立即插入使用单条 `backgroundTasks(toolUseId)` 加同会话投递。回环探针里直接传加急消息未能转后台，逐条调用原生接口已验证。用户也可针对所属任务调用 `stopTask(taskId)`。[Claude CLI 交互](https://code.claude.com/docs/en/interactive-mode#when-claude-code-sends-what-you-queued) · [SDK 接口](https://code.claude.com/docs/en/agent-sdk/typescript#backgroundtasks)
- 前台工具回执与后台任务通知分别确认。首个模型结果到达时继续持有活跃 Bash 所属进程，并接受同会话消息。按 SDK 会话、执行者和任务标识匹配回执。前台保存实际工具退出回执，确认已转后台的命令等待任务通知。自动转后台和日志读完后都会重新检查待发送消息。用私有临时根和会话、任务标识验证后台日志，复用原生回执的保存边界。缺少终态的命令进入待核对状态。受控命令、子代理和工作台 Git 仍由各自的授权与释放流程裁决。[Bash 时限](https://code.claude.com/docs/en/tools-reference#background-commands) · [临时目录](https://code.claude.com/docs/en/env-vars)
- 同一规范化目录内，各独立会话使用独立 SDK 进程、审批、取消令牌和消息历史。席位上限为三。目录租约继续用于工作台 Git、归档和清理。共享目录的受控副作用通过现有写入队列串行，并在执行时验证基线。用户需要隔离文件修改时可建立 worktree。[Claude worktree 文档](https://code.claude.com/docs/en/worktrees) · [Codex 0.172.0 会话注册](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/thread_manager/registry.rs)

## 验证与回退

用隔离目录、回环替身和真实 SDK 核对原生超时转后台、非零退出、单命令取消、消息先于后台完成交回以及同目录会话并行。用真实 Git 验证目录租约和原有席位上限。隔离 Electron 验证中英文工具控制、状态与日志。若出现跨会话取消或日志归属错误，回退执行及控制改动。旧历史继续使用原有工具状态，可选 Bash 元数据通过当前 SQLite 记录存储。
