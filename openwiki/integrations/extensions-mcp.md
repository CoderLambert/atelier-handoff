---
type: 集成支持
title: 扩展系统与 MCP 工具链
description: Atelier 应用的 Skills、Commands 和 MCP 扩展，以及编码助手如何通过项目级 OpenWiki 检索和更新文档。
tags: [mcp, extensions, skills, commands, openwiki]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-23T19:26:38.011Z
sources:
  - id: openwiki-source-f0035ce5a0edeeb448a6807a
    resource: repo://.claude/skills/openwiki/SKILL.md
  - id: openwiki-source-f5a489e5822d87c0b8fc66ef
    resource: repo://.mcp.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-913aada61bcdbf3cf08dc626
    resource: repo://server/extension-mcp.ts
generated: { by: "claude-code", at: "2026-11-22T13:27:54.578Z" }
---

# 扩展系统与 MCP 工具链

## Atelier 内的扩展

扩展页管理 `SKILL.md` 技能、Markdown 命令和 MCP 服务。公开 GitHub 仓库或文件支持预览后导入，SkillHub 市场用于预览并安装技能包。输入区用 `/` 选取技能或命令，用 `#` 选取本轮可用的 MCP 工具。是否能运行由项目绑定、工具授权、运行模式和可用的执行环境决定。

MCP 支持 stdio 和 Streamable HTTP。先核对导入配置，再测试连接、发现并选择工具，最后启用。受控工具需要的审批由本轮工作台运行处理。传输、连接生命周期和发现实现位于 `server/extension-mcp.ts`，运行时的工具曝光从 `server/agent.ts` 查起。操作说明见仓库 README 的「扩展与对话调用」。

## 编码助手的 OpenWiki

项目自带 OpenWiki 的 Claude Code Skill 和 MCP 配置。编码助手从当前仓库启动时可通过本机 `openwiki mcp --host claude` 进程发现工具。架构问题按需调用 `openwiki_search` 和 `openwiki_read`。也可从[快速上手](../quickstart.md)直接进入对应文档。

更新时，在编码助手中请求「按当前工作树增量更新中文 OpenWiki」。宿主会话负责查阅源码并撰写页面，OpenWiki 管理页面队列、源码证据校验与索引。接入命令、验收和回退记录在 `docs/decisions/2026-11-22-openwiki-host-integration.md`。应用内扩展的启用状态由 Atelier 单独管理。
