# 会话模型选择

在输入区按会话选择模型，默认沿用工作台配置。复用会话草稿保存队列。每次发送确定实际模型并写入 Run 配置，既有请求幂等和历史记录继续使用执行时的快照。更换模型后沿用现有 SDK 会话指纹与历史载入机制。

[Codex App Server](https://learn.chatgpt.com/docs/app-server) 的 `model/list` 提供客户端可见模型目录。[Shunt 0.64.0 的 `routes::get` 和 `snapshot`](https://github.com/pleaseai/shunt/blob/ace707b/src/routes.rs) 返回配置路由、路由器、推理深度及服务档位。本机 `/routes` 只有一条显式 GPT 路由，`/v1/models` 是 Claude 发现目录。读取实际路由和工作台默认模型。存在 ChatGPT Plan 路由时，通过本机 Codex 的 `model/list` 补充模型，按 ID 合并并优先保留路由配置。只有目录数据进入工作台，认证仍由各客户端管理。最终调用由 Shunt 路由。

前端采用 shadcn Select，在发送键旁直接选择模型，支持键入名称定位和手动填写完整 ID。模型目录不可用时仍可使用工作台默认值和手动 ID。验证目录合并、会话隔离、两次任务使用不同模型、历史快照和重开后还原。
