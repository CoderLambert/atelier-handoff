# 会话消息队列

## 问题与范围

活跃任务期间发送被输入区和运行时拒绝。连续提交应进入当前会话的 FIFO，上一轮退出后自动逐条执行。已排队的消息独立于正在编辑的草稿，用户可以撤回尚未开始的条目。

## 依据与选择

[Claude Code 的交互文档](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works)描述运行中发送、待处理列表与撤回。[Pi 的代理循环](https://github.com/badlogic/pi-mono/blob/e5d93ea0ab3747293dca5d12280361d04142eeb2/packages/agent/src/agent-loop.ts#L310)在循环结束时消费 follow-up。[Codex 的 input_flow.rs](https://github.com/openai/codex/blob/bb5b9c6240136de8ff4d30215e2341c44559aa04/codex-rs/tui/src/chatwidget/input_flow.rs#L252)从队首启动下一次输入。Atelier 在运行时的 SQLite 保存待处理意图，领取时转为现有 Run。待处理条目与会话执行历史分开，较早一轮的 SDK 上下文只读取已启动的消息，原有运行恢复逻辑继续处理已领取的工作。

入队固定文本、选定模型和深度、审批及费用配置、扩展和授权版本、项目上下文路径及附件标识。启动时读取已选项目文件并验证当前依赖仍可用。存储事务串行化顺序、幂等、撤回和启动。运行结束清理后释放执行槽，调度保持项目路径互斥和现有全局并发限制。手动停止只作用于当前轮。重启后的待处理队列通过输入区显式继续。

## 验证与回退

隔离运行时测试覆盖同会话 FIFO、幂等、撤回、配置失效和重启，真实 Linux 安装态使用回环 SDK 夹具从 Composer 发送并验证上一轮回复进入下一轮上下文。升级前保留 SQLite 一致性副本，旧版回退使用对应备份。
