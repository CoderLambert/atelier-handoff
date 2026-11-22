# 对话回退保留旧版本

## 范围

「回退对话到此处」以已验证的消息为包含式切点。操作完成后打开新版本，完整旧会话在侧栏显示为「回退前」。续聊使用当前项目目录和该轮实际授权。恢复项目文件和外部服务需要各自的历史版本。

## 参考与选择

- [Proma v0.19.58 `rewindPiAgentSession`](https://github.com/proma-ai/Proma/blob/f20943edd047ecdc929df67de9412d6e58cd4312/apps/electron/src/main/lib/agent-session-manager.ts#L950) 先从原生树导出切点，再更新展示历史和原生续聊目标。其 [运行时入口](https://github.com/proma-ai/Proma/blob/f20943edd047ecdc929df67de9412d6e58cd4312/apps/electron/src/main/lib/agent-orchestrator.ts#L2362) 将文件恢复标为不可用。
- [Codex 的 ThreadRollbackParams](https://github.com/openai/codex/blob/rust-v0.120.0/codex-rs/app-server-protocol/src/protocol/v2.rs#L3048) 描述会话历史截断，文件变更由客户端独立处理。
- [Atelier 消息分支决策](2026-11-21-message-branches.md) 已验证锁定的 Agent SDK 0.3.326 可以按消息生成独立原生记录，并在重启后恢复。回退复用该创建流程，以来源关系上的可选操作类型组织侧栏。旧版本继续持有原草稿、运行、审批及交付物。保留来源 ID 和消息 ID 可定位原消息。

## 并发、验证与回退

创建前和发布前均检查来源的运行、待审批、队列和消息边界。持久化完成后才切换当前会话，失败时按既有创建恢复流程清理未发布版本。以隔离用例验证重复提交、发布期间来源变化、重启与续聊。检查旧版本仍可打开，项目文件内容保持当前版本，普通分支继续照常显示。旧客户端可读取可选字段之外的记录，版本的原生记录仍可继续使用。
