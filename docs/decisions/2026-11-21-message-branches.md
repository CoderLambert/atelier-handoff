# 从会话消息创建分支

## 问题与范围

在 Atelier 中，从某条消息建立独立会话，分别尝试多个方案。分支以该消息为截止点，用户在新会话发送下一条指令。首个实现使用项目当前目录。独立 Git 工作区由对应实现指定起点提交和运行目录。

## 依据

- [Claude Agent SDK 会话指南](https://code.claude.com/docs/en/agent-sdk/sessions#fork-to-explore-alternatives)和[类型参考](https://code.claude.com/docs/en/agent-sdk/typescript#forksession)。安装的 `@anthropic-ai/claude-agent-sdk` 0.3.326 支持 `forkSession` 的 `upToMessageId`，包含选中消息并给分支分配新的消息 UUID。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)用 `thread/fork` 产生新线程 ID，以 `lastTurnId` 指定已完成的截止轮次。[rust-v0.120.0 的 `ThreadForkParams`](https://github.com/openai/codex/blob/rust-v0.120.0/codex-rs/app-server-protocol/src/protocol/v2.rs#L2782)体现线程 ID 和工作目录分别传递。
- [Open WebUI v0.6.34 的 `editMessage`](https://github.com/open-webui/open-webui/blob/v0.6.34/src/lib/components/chat/Messages.svelte#L264-L305)通过同父节点的兄弟消息演化单个会话。Atelier 的后续运行、草稿和持久 SDK 上下文按会话标识管理，所以分支采用独立会话。

## 实验与选择

在临时目录通过真实 SDK 和回环模型替身验证。用确定的用户 UUID 发送来源消息，再发送结束点之后的消息。从用户 UUID 创建 A/B 分支。创建步骤产生零个模型请求，分支继承截止消息并获得新 UUID。将 SDK 生成的两个 transcript 分别置于独立配置目录后，移除测试源目录。A、B 首次提交和 A 后续提交均续接各自 SDK ID。发送记录证明 A、B 继承公共起点，随后上下文各自独立。实验合计五个回环请求。

运行时记录应用消息对应的已验证 SDK 切点。SDK 负责产生结构化分支 transcript，运行时负责使其在新会话的配置根中可用。SQLite 保存分支来源和只读的显示前缀，各会话各自管理运行、草稿及审批。新一轮按实际配置核对授权。配置变更导致上下文重建时使用继承的显示历史和分支自己的后续记录。

## 旧消息的切点恢复

打开既有会话时，在会话自己的 SDK 配置目录读取原生记录。以保存的完整用户正文、完整助手回复和工具调用的闭合边界核对一对一对应关系。匹配成功时记录双方切点。只在原生记录与当前 SDK 会话相同时沿用已有配置指纹，配置指纹缺失时沿用配置变化后的正文恢复流程。真实数据的只读试算在 16 个会话中找到 9 个可恢复会话、110 条可恢复消息。

## 验证与回退

覆盖用户节点、助手最终回复、连续分支、创建失败与重试、进程重启、来源删除、配置变更和真实窗口导航。一次创建操作使用稳定的请求标识。故障恢复保留已确认的分支。发布前用隔离数据库副本验证分支前后的读写行为，分支入口可独立下线，先保全已生成的分支数据再回退运行时。
