# 会话上下文与提示缓存观测

## 问题与范围

用户希望在输入框旁看到当前会话的上下文窗口、占用组成和缓存命中率。原有 `Run.usage` 聚合任务内的模型用量。窗口是某个时间点的 SDK 工作上下文，缓存命中率则要从同一 API 请求的计数计算。三者保留各自口径。

## 依据与选型

- 锁定的 Claude Agent SDK 0.3.326 提供 `Query.getContextUsage({ detail: 'summary' })`。它在现有连接上回复有效窗口、分类和最近一次 API 响应的 `apiUsage`。分类为估算，`summary` 使用本地估算和已有响应，不发分类计数请求。另有 `full` 与 `/context`，适合要求单独计数的交互。[SDK TypeScript 参考](https://code.claude.com/docs/en/agent-sdk/typescript#sdkcontrolgetcontextusageresponse)
- 隔离的真实 CLI 回环探针在收到成功 `result`、流式输入仍可用时调用 `summary`。控制请求约 6 毫秒完成，整个会话只有一条 `/v1/messages`，返回有效窗口、`used`、`buffer`、`free` 和该请求的四项用量。
- Codex TUI 的 `context_window_line` 把窗口剩余百分比放在输入区页脚，并区分百分比与 token 显示。atelier 沿用输入附近的短提示和显式详情入口。Radix Popover 负责定位、键盘关闭与焦点恢复。[Codex TUI 页脚](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/footer.rs) · [Radix Popover](https://www.radix-ui.com/primitives/docs/components/popover)

## 决策

在 SDK 连接仍可用时有界采样，保留最新的有效快照并随 Run 存入已有 SQLite JSON payload。打开面板读取已有会话快照。采样失败时继续正常运行，界面可说明显示了上次数据或暂无数据。有效窗口按 SDK 的 `rawMaxTokens` 显示。占用组成、SDK 压缩预留和延迟项目分类显示。空间数据和会话运行累计用量分别存储。SDK 原始提示、工具参数、网格和文件路径不属于该数据契约。

缓存命中率使用最近一次 API 请求的缓存读取 token 除以未缓存输入、缓存读取与缓存写入之和。必需计数缺失或分母为零时显示暂不可用。实测的零值仍有意义。[Anthropic 提示缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

## 验证和回退

用实际 SDK 回环测试核对采样时机、分类、用量、超时与停止，证明观察过程只使用原有模型请求。通过会话快照验证历史数据和当前会话归属。用隔离桌面验证中英文、两种窗口尺寸、键盘与焦点，再把结果写入测试记录。数据字段为可选。回退时旧客户端可忽略新增字段，现有累计用量与运行交付仍由原路径提供。
