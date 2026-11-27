# C1 第 3 步：提取运行转录账本

## 问题与范围

Node 运行时的 `AgentRunner` 同时编排 SDK、实时输入、工具执行和清理，并直接维护转录顺位、通知及刷盘计时器。本轮把转录状态集中到每轮运行独有的 `RunTranscriptLedger`。用户仍从原会话入口接收流式回复、插话与工具状态。持久格式、运行终态判定和进程托管沿用现有实现。[桌面路线图 P5](../../openspec/roadmaps/build-atelier-desktop/roadmap.md#阶段与依赖)

## 依据与选择

- Claude Agent SDK 0.3.332 的锁定类型和 `server/run-transcript.ts` 已能合并流帧和完整回执。Codex 的 `ThreadItem` 将会话条目和生命周期作为协议字段，采用它会引入另一套条目契约。继续复用本仓的 SDK 归属算法和版本 1 转录数据。[Claude SDK 流式输出](https://code.claude.com/docs/en/agent-sdk/streaming-output) · [Codex ThreadItem 源码](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts) · [有序对话决策](2026-11-26-ordered-conversation.md)
- Node 的 `setInterval` 和 `clearInterval` 已覆盖周期刷盘与同步清理。保留 80 ms 周期，测试通过注入定时能力和内存宿主驱动。账本决定写入及持久事件的事务范围，现有 `Store` 在提交后通知订阅者。[Node 定时器文档](https://nodejs.org/api/timers.html) · [Node v24.11.1 定时器源码](https://github.com/nodejs/node/blob/v24.11.1/lib/timers.js#L976-L1005) · [Store](../../server/store.ts)
- 保留两个清理时点。取消权限后停表并刷盘，清理 SDK 和后台工作后，在原终态事务内提升未收到流帧的 Hook 顺位并生成最终转录。

## 验证与回退

用内存宿主断言初始化、插话归属、80 ms 定时和显式刷盘、工具与流帧的两种到达顺序、拒绝时间戳、通知去重及两阶段收尾。以 `node --import tsx` 运行转录测试和架构检查，再核对四组 TypeScript、文件头和格式。

如消息位置、通知、事务或收尾时序出现回归，恢复 `server/agent.ts` 的转录逻辑并移除账本接线。原有版本 1 转录记录可直接继续读取，无需数据迁移。
