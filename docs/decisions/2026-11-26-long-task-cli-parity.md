# 长任务沿用 Claude 的派发与消息回执

## 故障与范围

本机信任会话在 22:18:58 把追问交给 SDK，主助手在 22:19 回复后派发两个子任务。两个分支都在工作，前台工具等待持续到用户于 22:34 停止本轮。消息一直显示「发送中」，停止后转为「发送结果待确认」。配对桌面用独立 SQLite 写者持有会话和队列，运行时通过流式输入连接持有 Claude SDK，界面消费快照与 SSE。

用锁定的 SDK 0.3.332 和 CLI 2.1.332 在隔离项目、回环模型上重复了两处偏差。子任务未释放时，传给原生工具的省略值和 `true` 均产生后台任务与 `async_launched`，父会话先继续，`false` 下父会话等到完整的 Agent 工具回执。Atelier 总是传 `false`，并拒绝显式 `true`。同一 SDK 的流式事件在结果之前携带输入标识，`--replay-user-messages` 也能在取出排队输入时回显对应 UUID。试验中前台分支仍阻塞时，排队输入没有被回显。Atelier 只用整轮 `result` 释放单条插话槽。回归夹具在插话回复后立即发出两个前台 Agent，保留分支的未完成请求，复现原消息占槽及停止后的错误状态。

原会话的部分模型请求到下一条模型输出约为 2–3 分钟。此证据不区分模型推理与上游传输，也不构成挂死判据。

## 参考与取舍

- [Claude Code 队列与插话](https://code.claude.com/docs/en/interactive-mode#when-claude-code-sends-what-you-queued)、[前台和后台子代理](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)与[SDK 消息关联](https://code.claude.com/docs/en/agent-sdk/typescript#user_message_uuid)定义了交互、UUID 回显及原生任务控制。以本地锁定版本的 `claude --help`、`sdk.d.ts` 和实验输出为实现基准。
- [openai/codex 0.172.0 的消息处理分发](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/app-server/src/message_processor.rs#L1828-L1837)把追加指令与整轮打断分成不同的请求。[earendil-works/pi 的运行循环](https://github.com/earendil-works/pi/blob/ab58ca368b5c388d82c63189d4ce329626f0b7a1/packages/agent/src/agent-loop.ts#L195-L209)在消息加入上下文时发出消息事件，之后继续工具和模型循环。两者均把输入生命周期与整轮生命周期分开。直接接入其他运行器会接管已由 Claude SDK 管理的工具与权限，因此只采用这个状态边界。
- 用耗时阈值切换后台或重放指令会引入分支副作用重复，且不能判断消息实际已被消费。采用锁定 SDK 提供的执行选择、投递回执与结果标识。

## 决策与执行

1. 本机信任按原样传递原生 Agent 的省略、`true` 和 `false` 三种选择。受控执行继续使用前台和原审批边界。允许的 Agent 类型、工具和禁止嵌套沿用现有规则。根据 SDK 实际启动、交接和终态的身份更新分支，考虑工具 hook 先到和迟到通知。
2. 运行时用已派发消息自己的 UUID 核对 SDK 主线程的回显或答复。在整轮仍有后续工作时就提交现有队列确认事务并释放输入槽。接收、整轮结果及分支终态各有自己的生命周期。保留匹配正常结果的兼容路径，停止后未见有效回执的消息保留待核对状态。继续使用现有幂等记录、会话范围和取消信号。
3. SDK 初始化前和上一条输入尚未确认时，兼容消息留在队列。输入槽可用后才提供立即插入。实验中加急输入打断旧回复，旧结果先到，新请求已经在途，原生状态仍为 `running`。本机信任要求原生 `idle` 状态后才开始未匹配回执的收尾等待，避免按旧结果开始计时而关闭仍在处理新指令的输入流。用户可继续 Enter 排队，或 Ctrl+Enter 使用现有立即插入。运行中显示子任务数量及各分支最近的实际工具活动，整轮计时明确标注。从展开的任务控制保留单独停止。
4. 最后一个后台分支的完成通知可以触发主助手的新汇总请求。真实 SDK 重放了先前在该通知处关闭插话槽的行为，即使报告稍后显示，汇总期间仍无法发送。原生运行完成后等同会话的 `idle` 再结束输入。夹具暂停汇总请求并在同轮送达第三条消息，独立验证报告回收和输入仍可用。

## 验证与回退

隔离复跑 `node --import tsx --test tests/native-subagent-insertion-sdk.test.ts`，包含停止前后、汇总期间插话、原生后台派发、前台批次与单分支停止。关联消息顺序和原生 Bash 回归，运行全量质量门槛。在隔离 Electron 窗口用中英文核对回执、继续插话和收齐报告。验收记录进入[执行日志](../../openspec/roadmaps/build-atelier-desktop/task-log.md)。

本次沿用现有 SQLite 列和确认事务。回退可恢复上一份桌面构建或还原这批源码，保持同一数据根、浏览器 profile 与网关。已持久确认的消息按已有幂等记录读取，旧版本遗留的待核对历史保留原状态。
