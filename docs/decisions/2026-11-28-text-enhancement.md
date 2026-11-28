# 一键增强提示词

首版在新会话和已有会话的输入工具栏提供增强、取消和撤销。运行时负责模型请求。渲染进程保管请求对应的编辑目标、原文和撤销记录。聊天仍通过既有草稿与发送接口处理引用、附件和运行。

## 查阅与取舍

- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create) 将固定指令与用户正文分别放在 `system` 和 `messages`。完整响应以 `end_turn` 结束。检查完成原因和文本块后才回填。
- [open-webui/open-webui，4720ff1，routers/tasks.py](https://github.com/open-webui/open-webui/blob/4720ff19e711d01f48d2b732dcbac63205221f5d/backend/open_webui/routers/tasks.py#L385) 的 `generate_queries` 单独路由模型辅助任务，选择任务模型并从消息序列构造查询。atelier 采用独立路由，由服务端选择工作台默认模型，传输内容限于固定指令和当前正文。
- [lobehub/lobehub，559ae7c，builtin-tool-group-agent-builder/src/systemRole.ts](https://github.com/lobehub/lobehub/blob/559ae7ce83f9d4ff52b24401c2696bdc84ff94be/packages/builtin-tool-group-agent-builder/src/systemRole.ts#L9) 的 `systemPrompt` 定义专用改写指令，也注入群组配置并开放配置工具。atelier 的编辑器只请求改写正文，响应仅能经带原文比较的草稿回调写入。
- 仓内 Git 提交说明已经通过网关调用无会话的 Messages API，沿用 `GatewayService` 和 `gatewayToken`，复用 HTTP 断开机制。通过既有运行器处理会引入会话、队列和工具生命周期，违背首发前保持零运行记录的要求。

## 实现与验收

用共享 schema 限定用途、正文和响应，输入输出沿用聊天正文 32,000 字符上限。上游限时 30 秒，连接断开时取消，每个编辑目标同时只有一个请求。正文变更、发送、切换目标和卸载均使在途响应失效。撤销只对仍为增强结果的正文生效。引用占用的发送长度继续由聊天校验。

用临时数据根与回环模型断言请求边界、取消、限时、无效响应及零会话、运行、队列副作用，再用独立表单验证共享组件，用隔离 Electron 验收中英文键盘操作与正式首发。执行入口及结果登记在[桌面执行日志](../../openspec/roadmaps/build-atelier-desktop/task-log.md)。回退时移除工具栏入口和路由，继续读取原有草稿。
