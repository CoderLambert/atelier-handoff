---
type: 系统架构
title: 数据持久化与模型映射
description: Node 运行时的数据目录、SQLite 排他所有权、Drizzle 会话快照、分支记录和工作区设置。
tags: [database, sqlite, drizzle, session-snapshot, persistence]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-22T13:27:54.578Z
sources:
  - id: openwiki-source-e275da6f88f7ddcacfc7ebc9
    resource: repo://server/data-owner.ts
  - id: openwiki-source-2461f87f892c0122eb84e105
    resource: repo://server/db/repositories/session-snapshot.ts
  - id: openwiki-source-98607f5a7f86340e17e82c0e
    resource: repo://server/db/repositories/workspace-layout.ts
  - id: openwiki-source-278f3d3c13199301407be57e
    resource: repo://server/db/schema/session-snapshot.ts
  - id: openwiki-source-3fa62e7db05e246c4b1a480b
    resource: repo://server/main.ts
  - id: openwiki-source-c46e1d4f79fe7b3e7f49378f
    resource: repo://server/session-forks.ts
generated: { by: "claude-code", at: "2026-11-22T13:27:54.578Z" }
---

# 数据持久化与模型映射

Node 运行时在打开应用服务之前通过 `acquireDataOwner` 取得数据目录的排他所有权。Web 开发模式默认用仓库里的 `.data/`，可通过 `ATELIER_DATA_DIR` 指定隔离目录。桌面启动器负责解析自己的数据路径并交给运行时。SQLite 保存业务记录，附件和交付物内容由文件存储维护。

## 会话快照与历史

会话快照是对现有记录的读取投影。`server/db/schema/session-snapshot.ts` 映射项目、会话、运行、消息、工具、审批、附件、交付物与事件等表。`sessionSnapshotRepository` 先读取会话及项目，再按会话 ID 读取相关记录并映射；可见附件和近期事件有各自的筛选规则。用例经仓储接口读取，避免让 HTTP 或 renderer 直接访问 ORM。参见 `tests/session-snapshot-orm.test.ts`。

会话分支以已记录的消息锚点派生 SDK transcript。回退也会创建会话分支，并在提交新会话的事务中复核来源历史是否仍符合预期。工作台据分支关系显示历史，已经发生的文件和命令副作用需要独立核查。

## 工作区设置

`workspaceLayoutRepository` 在 `settings` 表中保存上次工作台位置、最近会话位置与布局。保存会话位置时，当前位置和最近会话在同一事务中记录；布局键独立持有侧栏宽度等默认值。可从[工作台导航与会话操作](../concepts/workspace-navigation.md)沿路由找到对应 UI。
