---
type: 核心概念
title: 工作台导航与会话操作
description: 工作台 Hash 路由、恢复位置、项目会话树、消息分支、引用和工具明细的入口。
tags: [workspace, routing, settings, conversation, layout]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-23T19:36:38.791Z
sources:
  - id: openwiki-source-6127afb5191b21fc48dc7766
    resource: repo://frontend/src/app/workspace-panels.tsx
  - id: openwiki-source-b7b36166e65355583deb5a23
    resource: repo://frontend/src/app/workspace-router.tsx
  - id: openwiki-source-7b1c7e5d566b79606d2c8b9b
    resource: repo://frontend/src/app/workspace.tsx
  - id: openwiki-source-932b361d60499b3afca9dd41
    resource: repo://frontend/src/features/chat/composer.tsx
  - id: openwiki-source-b7252bc2748b128c688a6cdd
    resource: repo://frontend/src/features/chat/message-actions.test.ts
  - id: openwiki-source-ae01d9a6ecd87bfcaaecc27a
    resource: repo://frontend/src/features/chat/session-tree.test.ts
  - id: openwiki-source-63b3e2be45873f4504d4e7e7
    resource: repo://frontend/src/features/extensions/picker-model.ts
  - id: openwiki-source-98607f5a7f86340e17e82c0e
    resource: repo://server/db/repositories/workspace-layout.ts
generated: { by: "claude-code", at: "2026-11-23T19:36:38.791Z" }
---

# 工作台导航与会话操作

`workspace-router.tsx` 定义 TanStack Router 的 Hash 路由。会话 URL 可指向对话、指定运行的轨迹、成果、浏览器或单条消息。设置是独立页面，`/settings` 进入模型设置，另有布局与诊断页。工作台通过共享的路径校验规则恢复持久化位置，并记录最近打开的会话。布局设置与路由位置独立保存。[SQLite 持久化](../architecture/database-storage.md)

## 会话树与消息

侧栏按项目组织会话树。分支搜索保留匹配项的祖先路径，回退占据原树位置，旧版本仍可查看。消息操作按角色、可用回调及 SDK 锚点显示。分支和回退各自校验条件，回退有活动运行或待处理操作时不可用。相关用例见 `frontend/src/features/chat/session-tree.test.ts` 与 `message-actions.test.ts`。

「引用回复」把选中内容加入输入区引用卡片，发送时与可编辑正文组合。运行允许即时插入时，`Alt + Enter` 提交当前草稿并发起插入。当前执行明细显示在助手消息内，历史回执可按需打开。查看回执分页和日志搜索见[Agent 运行时](../architecture/agent-runtime.md)。

## 输入区文件引用（开发中）

当前未提交工作区实现中，输入 `@` 可触发文件候选，选择目录继续下钻，选择文件则插入路径文本。它与「+ 上下文」的 `contextPaths` 分开：行内引用不自动把文件全文放进上下文。检索由服务端项目文件接口处理，并过滤敏感路径。该功能本次未做验收，行为以正在开发的源码及测试为准；设计记录见 `docs/decisions/2026-11-24-composer-file-mentions.md`。

## 调整布局

`WorkspacePanels` 将像素宽度与窗口可用空间结合，处理左右面板的宽度、折叠与中栏最小宽度。工作区设置负责持久化偏好。模型和默认网关从「设置 → 模型与网关」管理。[模型目录与网关路由](../integrations/model-gateways.md)
