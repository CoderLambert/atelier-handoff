# 实时插话与输入排空拆分（C1 第 2 步）

`server/agent.ts` 的 SDK 流、工具 Hook 和退出路径共同推进实时插话状态。把输入队列、插话槽、前台任务交接和空闲结算收敛到 `LiveTurnCoordinator`。用户继续从原聊天队列插话，执行仍在 Node 运行时。

- Claude Agent SDK 类型参考和锁定版 0.3.332 的 `sdk.d.ts` 定义了指定调用的后台切换、输入 UUID 及 `session_state_changed`。复用现有 SDK 流和 Bash、子代理生命周期。允许的前台调用逐项复核后交接，消息仍在 SDK 回显、答复或匹配结果时确认。[Claude Agent SDK 类型参考](https://code.claude.com/docs/en/agent-sdk/typescript#backgroundtasks)
- pi 在下一次模型回复前独立交付插话，Codex 的 `wait_agent` 随输入活动退出等待。这里保留 Claude 的原生交接和报告回收，由协调器通过窄接口调用现有执行端。消息写入、助手占位及事件发布仍由运行宿主负责。[pi 的运行循环](https://github.com/earendil-works/pi/blob/ab58ca368b5c388d82c63189d4ce329626f0b7a1/packages/agent/src/agent-loop.ts#L195-L209) · [Codex 的 `wait_agent`](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)
- 原生模式使用同一 SDK 会话的空闲信号启动 120 秒结算或结束输入。受控模式保留模型状态判定。结果先匹配输入 UUID，宿主随后记录结果，再决定继续、等待或收尾。队列授权和续跑沿用既有约定。[子代理插话](2026-11-25-claude-subagent-insertion.md) · [长任务与回执](2026-11-26-long-task-cli-parity.md) · [队列续跑](2026-11-27-queued-followup-scope.md)

用架构、类型、文件头和定向测试验收。内存测试注入计时器，核对输入入流、回执、任务交接和空闲排空时序。完整运行时和 Electron 验收由主会话执行。若出现插话拒绝、回执、发布或排空顺序回归，将状态及调用还原到 `server/agent.ts` 并移除协调器，原 SQLite 数据可直接使用。
