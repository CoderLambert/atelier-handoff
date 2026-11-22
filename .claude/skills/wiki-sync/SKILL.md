---
name: wiki-sync
description: 按当前工作树增量同步本项目的中文 OpenWiki。
disable-model-invocation: true
---

# 同步项目 OpenWiki

在当前会话中运行仓库自带的 OpenWiki Skill。加载 `openwiki`，或从项目根读取 `.claude/skills/openwiki/SKILL.md`。以 `git rev-parse --show-toplevel` 和项目 Skill 的位置确认目标仓库。从上级工作区启动时，使用包含此 Skill 和 `.mcp.json` 的仓库作为目标。

按上游 Skill 执行 `openwiki_begin`，传入绝对仓库路径、`mode: "update"` 和 `language: "zh-CN"`。复核自上次同步以来的提交及当前工作树中相关的已跟踪和未跟踪文件。使用当前会话模型处理 OpenWiki 返回的页面队列和事实校验。继续已有运行，直到 `openwiki_finish` 返回 `complete`，或 `openwiki_begin` 返回 `noop`。

MCP 未连接时，说明原因并提示在项目根重新打开 Claude Code，允许项目的 `openwiki` MCP 后重试。使用现有会话模型与宿主管线，禁止改走独立生成 CLI、子代理、定时任务或 CI。保留已有源码和未提交改动，禁止提交或推送。完成后说明实际更新的页面、待处理问题，或为什么无需更新。
