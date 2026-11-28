---
type: 核心概念
title: 工作台导航与会话操作
description: 工作台 Hash 路由、恢复位置、项目会话树、消息分支、引用和工具明细的入口。
tags: [workspace, routing, settings, conversation, layout]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-27T05:51:26.216Z
sources:
  - id: openwiki-source-d9794e6742cf5cbd10f84e5c
    resource: repo://docs/panel-development.md
  - id: openwiki-source-849e017f0de8393ad32567ea
    resource: repo://frontend/src/app/drafts.ts
  - id: openwiki-source-48cc9addc812d490b6915f1e
    resource: repo://frontend/src/app/panels/use-workspace-panel.ts
  - id: openwiki-source-6526fd1f5fd26f786156cfe4
    resource: repo://frontend/src/app/use-workspace-navigation.ts
  - id: openwiki-source-6127afb5191b21fc48dc7766
    resource: repo://frontend/src/app/workspace-panels.tsx
  - id: openwiki-source-b7b36166e65355583deb5a23
    resource: repo://frontend/src/app/workspace-router.tsx
  - id: openwiki-source-332d602bdc01e5066563eed7
    resource: repo://frontend/src/app/workspace-state.ts
  - id: openwiki-source-932b361d60499b3afca9dd41
    resource: repo://frontend/src/features/chat/composer.tsx
  - id: openwiki-source-ae01d9a6ecd87bfcaaecc27a
    resource: repo://frontend/src/features/chat/session-tree.test.ts
  - id: openwiki-source-88a14fce9a386fb9ad02e310
    resource: repo://frontend/src/features/chat/use-composer-keymap.ts
  - id: openwiki-source-98607f5a7f86340e17e82c0e
    resource: repo://server/db/repositories/workspace-layout.ts
generated: { by: "claude-code", at: "2026-11-28T07:11:46.812Z" }
---

# 工作台导航与会话操作

`workspace-router.tsx` 定义 TanStack Router 的 Hash 路由。会话 URL 可指向对话、指定运行的轨迹、成果、浏览器或单条消息。设置是独立页面，`/settings` 进入模型设置，另有布局与诊断页。工作台通过共享的路径校验规则恢复持久化位置，并记录最近打开的会话。布局设置与路由位置独立保存。自动化任务另有独立 `/schedules` 页面，见[自动化任务与运行历史](./scheduled-tasks.md)。[SQLite 持久化](../architecture/database-storage.md)

## 会话树与消息

侧栏按项目组织会话树。分支搜索保留匹配项的祖先路径，回退占据原树位置，旧版本仍可查看。消息操作按角色、可用回调及 SDK 锚点显示。分支和回退各自校验条件，回退有活动运行或待处理操作时不可用。相关用例见 `frontend/src/features/chat/session-tree.test.ts` 与 `message-actions.test.ts`。

「引用回复」把选中内容加入输入区引用卡片，发送时与可编辑正文组合。运行允许即时插入时，`Alt + Enter` 提交当前草稿并发起插入。当前执行明细显示在助手消息内，历史回执可按需打开。查看回执分页和日志搜索见[Agent 运行时](../architecture/agent-runtime.md)。

## 输入区文件上下文

使用「+ 上下文」显式选择项目文件；绑定工作树的会话将会话 ID 传给文件选择器，选中的路径独立保存在草稿的 `contextPaths` 中。

## 调整布局

`WorkspacePanels` 将像素宽度与窗口可用空间结合，处理左右面板的宽度、折叠与中栏最小宽度。Git、浏览器和终端共用右栏的停靠、全屏和收起机制。收起只隐藏面板，不销毁当前工具资源；单个标签的关闭另行处理。工作区设置负责持久化停靠偏好。模型和默认网关从「设置 → 模型与网关」管理。[模型目录与网关路由](../integrations/model-gateways.md)
