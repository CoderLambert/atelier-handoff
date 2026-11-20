# 会话推理深度

模型菜单采用单行名称。发送区新增推理深度选择，沿用会话草稿的串行保存。发送时将选择写入 Run 配置，模型改变后恢复默认档位，重试读取来源任务的实际配置。

[Agent SDK TypeScript 参考](https://code.claude.com/docs/en/agent-sdk/typescript#options) 提供 `effort`。[Claude Code 环境变量](https://code.claude.com/docs/en/env-vars) 的 `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` 支持自定义模型名。[Shunt 0.64.0 的 effort 转换](https://github.com/pleaseai/shunt/blob/ace707b/src/model/responses_request.rs#L1077) 在路由配置优先的前提下把 `output_config.effort` 转为 Responses `reasoning.effort`，并按模型映射 `max`。采用 SDK 已支持的五个档位，与 Codex 目录公开的档位取交集。路由固定时显示该档位。

用打包 SDK 和回环网关核对实际请求中的 effort，验证下一条消息和重开时的选择。设置默认档位可恢复升级前的请求行为。
