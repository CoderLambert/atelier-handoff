# 本机信任会话向运行中的子代理批次插话

用户在本机信任会话运行前台子代理时，可以通过现有「立即插入」和 Ctrl+Enter 将新指令交给主会话。子代理继续完成原委派，主会话可以在它们结束前回复，随后收到各分支报告。确认范围为用户主动插话时的原生子代理切换，前台派发与按条发送沿用当前行为。

## 依据与选择

[Claude CLI 发送队列消息](https://code.claude.com/docs/en/interactive-mode#when-claude-code-sends-what-you-queued)说明，立即发送会让可转后台的前台子代理继续执行。锁定 SDK 0.3.332 的 `Query.backgroundTasks(toolUseId)` 支持指定调用。[SDK 类型参考](https://code.claude.com/docs/en/agent-sdk/typescript#backgroundtasks) · [Claude 子代理生命周期](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)

以同批启动两个前台子代理的回环探针核对配套 CLI 2.1.332。逐个调用 SDK 后台接口后，主会话收到新指令并返回回执，此时两个模拟请求仍在等待释放。两个 Agent 回调均返回 `async_launched`，后续 `task_notification` 携带各自结果摘要，主模型接收两份报告。前台分支的详细报告仍来自现有 Agent 完成回调。后台摘要从匹配的 SDK 终态读取，宿主无需读取 SDK 输出文件。

Codex 0.172.0 的多代理 `wait_agent` 在收到用户插话时退出等待，子线程继续独立运行。Atelier 使用已经负责模型上下文与报告回送的 Claude 原生任务，避免增加第二套调度和消息转发。[Codex wait.rs](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs) · [原有子代理选择](2026-11-21-subagents.md)

## 状态与验证

- 运行时按会话、任务、单次任务运行和 Tool Use ID 关联回执，只移动主会话中已登记且可识别的调用。SDK 持有后台生命周期，现有分支身份、权限审核和单独停止继续有效。分支内部工具归属于原子代理。普通消息沿用工具检查点。
- 在收到后台交接回执后继续跟踪 Agent 工具和子代理，直到实际终态。早到的完成通知等到交接确认再采用。主回复先展示，SDK 继续收取后台结果，整轮在收尾完成后结束。使用现有会话、工具和子代理记录，回退无需更改数据库。
- 回归先在隔离目录和回环模型复现本机信任模式的插话被拒绝，再验证普通排队、立即插话、后台工具归属、报告返回和停止单分支。运行全量检查、测试、构建，在隔离 Linux Electron 窗口验证同一交互。发生错误时可回退本次运行时改动，恢复此前 Agent 前台等待。
