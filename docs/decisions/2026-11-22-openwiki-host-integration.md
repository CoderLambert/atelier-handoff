# OpenWiki 项目级接入与更新

## 问题与范围

仓库已有中文 `openwiki/`，上次生成记录为 `host-agent/antigravity`。本机 OpenWiki 的安装清单显示 Claude Code 项目级接入缺失。当前工作树包含尚未提交的实现，本次文档以实际工作树的源码和测试为证据。接入用于编码助手的仓库文档维护，应用内部的 MCP 扩展另有自己的运行时与授权机制。

## 查阅来源与候选

核对 `langchain-ai/openwiki` 安装文档及本机 0.9.0 checkout `dcb803e`。`src/integrations/install/registry.ts` 定义 Claude Code 的项目级 Skill 和 `.mcp.json` 位置。`src/integrations/mcp/server.ts` 暴露检索与生成工具。`src/generation/repository-run.ts` 负责续跑、证据对齐和收尾。参阅[上游安装文档](https://github.com/langchain-ai/openwiki#coding-agent-integrations)与[项目执行日志](../../openspec/roadmaps/build-atelier-desktop/task-log.md)。

- 项目级宿主管线复用本会话模型，使用 OpenWiki 的本地 stdio MCP 管理页面、引用和索引。
- CLI 独立生成和现有 Actions 模板使用各自配置的模型和凭据，适合另行配置的定时任务。
- 从头初始化会开启替换流程。增量更新会保留原有页面路径和仍有效的事实，便于兼容当前 Wiki 的链接。

## 决策与验收

使用上游 `openwiki integrations install claude --project` 安装仓库内的 Skill 和 MCP 配置。本次采用已有中文 Wiki 的 `update` 生命周期。当前会话撰写，OpenWiki 记录宿主标识并校验源码证据。既有 GitHub Actions 文件属于独立自动化，本次本地更新路径为宿主管线。

用项目安装状态及 MCP 工具列表检查接入。以 `openwiki_finish` 返回 `complete`、现有页面可检索且引用和页面链接可解析为验收依据。接入可用 `openwiki integrations uninstall claude --project` 解除，已生成 Wiki 可独立保留。
