---
type: 快速上手指引
title: Atelier 快速上手
description: 启动本机 AI 工作台，并按开发任务定位运行时、工作区、模型、权限和桌面发行文档。
tags: [atelier, quickstart, local-workbench, development]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-27T05:51:26.216Z
sources:
  - id: openwiki-source-b7b36166e65355583deb5a23
    resource: repo://frontend/src/app/workspace-router.tsx
  - id: openwiki-source-e50eb37efa5218d0fb6b2b47
    resource: repo://frontend/src/features/schedules/schedule-form.tsx
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-9cb1e02f59a7fc96ce5b1ac2
    resource: repo://server/agent.ts
  - id: openwiki-source-3fa62e7db05e246c4b1a480b
    resource: repo://server/main.ts
  - id: openwiki-source-1123c47d903d85e42ad2a33f
    resource: repo://tests/schedules.test.ts
generated: { by: "claude-code", at: "2026-11-28T07:11:46.812Z" }
---

# Atelier 快速上手

Atelier 是面向本机项目的 AI 工作台，通过 Claude Agent SDK 执行会话。可从浏览器或 Electron 桌面开始，模型与网关在工作台设置中选择。

## 启动

项目要求 Node.js 24 或以上版本。在仓库根执行：

```sh
npm ci
npm start
```

`npm start` 先构建前端，随后启动回环 HTTP 服务，默认打开 `http://127.0.0.1:4317`。热更新时在两个终端分别运行 `npm run dev:server` 和 `npm run dev`，访问 Vite 默认地址 `http://127.0.0.1:5173`。开发桌面使用 `npm run desktop`。基础验证命令为 `npm run check`、`npm test` 和 `npm run build`。

## 按任务查阅

| 想查的问题 | 文档 |
| --- | --- |
| Electron、Node、React 和网关由谁负责 | [系统架构全景](./architecture/overview.md) |
| 如何定位设置、会话、分支、回退和引用 | [工作台导航与会话操作](./concepts/workspace-navigation.md) |
| 如何设置桌面主题、提示音和通知 | [桌面外观与通知](./concepts/appearance-notifications.md) |
| Git 看板及开发会话如何组织，工作树如何归档和恢复 | [Git 工作台与开发会话](./concepts/git-workbench.md) |
| 如何创建定时或手动任务、设置模型并排查触发历史 | [自动化任务与运行历史](./concepts/scheduled-tasks.md) |
| 模型如何选择，Shunt 与 Magpie 如何发现和路由 | [模型目录与网关路由](./integrations/model-gateways.md) |
| 一轮运行如何执行、推送、恢复和读取工具日志 | [Agent 运行时与会话调度](./architecture/agent-runtime.md) |
| SQLite 存哪些记录，如何读取会话快照 | [数据持久化与模型映射](./architecture/database-storage.md) |
| 只读、受控、自动审批和本机信任各适用什么情况 | [受控权限与本机信任](./concepts/security-permissions.md) |
| Explore 与 Worker 如何委派和停止 | [会话子代理与并发委派](./concepts/subagents.md) |
| 如何启用应用 MCP，或用编码助手更新 Wiki | [扩展系统与 MCP 工具链](./integrations/extensions-mcp.md) |
| 如何构建 Linux x64 包并验证安装件 | [桌面端打包与运维构建](./operations/desktop-build.md) |
