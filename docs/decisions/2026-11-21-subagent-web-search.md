# 子代理站点搜索

用户要求两个子代理通过模型网关分别搜索百度和今日头条的域名，并能分别核对两项调用。授权仍沿用 Atelier 当前项目与会话的工具策略。

[Shunt 0.64.0 的 `web_search_tool`](https://github.com/pleaseai/shunt/blob/ace707b/src/model/responses_request.rs#L886) 将 Anthropic 托管搜索及域名过滤映射到现有模型路由。[`[server.codex_endpoint]` 校验](https://github.com/pleaseai/shunt/blob/ace707b/src/config.rs#L5189) 要求另一类 OAuth 账户。实测现有 ChatGPT Plan 路由的 `/v1/messages` 接受托管搜索并返回独立的搜索事件。本地工具沿用当前模型网关，通过同一授权发起搜索，校验响应 URL 的主机名并保留来源记录。

证据和验收包含回环请求的域名限定、结果过滤、子任务来源，以及经真实 Shunt 的两站公开查询。上游未返回符合条件的引用时，工具返回空结果与明确原因。禁用本机原生搜索工具的回退仍可通过指定的 Skill 或 MCP 配置处理搜索任务。
