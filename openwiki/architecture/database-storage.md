---
type: 系统架构
title: 数据持久化与模型映射
description: Node 运行时的数据目录、SQLite 排他所有权、Drizzle 会话快照、分支记录和工作区设置。
tags: [database, sqlite, drizzle, session-snapshot, persistence]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-27T05:51:26.216Z
sources:
  - id: openwiki-source-e275da6f88f7ddcacfc7ebc9
    resource: repo://server/data-owner.ts
  - id: openwiki-source-c25b23396141a24d1ae248db
    resource: repo://server/db/connection.ts
  - id: openwiki-source-8d1b6f71e7679cea2eef57a4
    resource: repo://server/db/migrations/0011-runtime-hotpath-indexes.sql
  - id: openwiki-source-2461f87f892c0122eb84e105
    resource: repo://server/db/repositories/session-snapshot.ts
  - id: openwiki-source-98607f5a7f86340e17e82c0e
    resource: repo://server/db/repositories/workspace-layout.ts
  - id: openwiki-source-013b450d86da1bcd8d9ca8bf
    resource: repo://server/db/schema/schedules.ts
  - id: openwiki-source-278f3d3c13199301407be57e
    resource: repo://server/db/schema/session-snapshot.ts
  - id: openwiki-source-3fa62e7db05e246c4b1a480b
    resource: repo://server/main.ts
  - id: openwiki-source-c46e1d4f79fe7b3e7f49378f
    resource: repo://server/session-forks.ts
  - id: openwiki-source-6198df9813cbedd50ce1f61a
    resource: repo://tests/runtime-orm-queries.test.ts
generated: { by: "claude-code", at: "2026-11-28T07:11:46.812Z" }
---

# 数据持久化与模型映射

Node 运行时在打开应用服务之前通过 `acquireDataOwner` 取得数据目录的排他所有权。Web 开发模式默认用仓库里的 `.data/`，可通过 `ATELIER_DATA_DIR` 指定隔离目录。桌面启动器负责解析自己的数据路径并交给运行时。SQLite 保存业务记录，附件和交付物内容由文件存储维护。

## 会话快照与历史

会话快照是对现有记录的读取投影。`server/db/schema/session-snapshot.ts` 映射项目、会话、运行、消息、工具、审批、附件、交付物与事件等表。`sessionSnapshotRepository` 先读取会话及项目，再按会话 ID 读取相关记录并映射；可见附件和近期事件有各自的筛选规则。用例经仓储接口读取，避免让 HTTP 或 renderer 直接访问 ORM。参见 `tests/session-snapshot-orm.test.ts`。

会话分支以已记录的消息锚点派生 SDK transcript。回退也会创建会话分支，并在提交新会话的事务中复核来源历史是否仍符合预期。工作台据分支关系显示历史，已经发生的文件和命令副作用需要独立核查。

## 迁移与热路径

`server/db/connection.ts` 打开 SQLite、组装 Drizzle 仓储并注册版本迁移，当前 schema 为 v15。v11 为运行、工具、审批和交付物添加从 JSON 派生的状态或运行 ID 列及索引，保持 JSON 为权威数据；这样中断恢复和运行详情可按状态或运行 ID 查询，而不必在应用层扫描整个记录集合。`tests/runtime-orm-queries.test.ts` 验证 v10 升级、失败回滚和热路径查询计划。

v12–v15 分别引入定时任务和触发历史、触发配置、执行偏好以及模型和推理强度。任务定义与每次触发的历史分开保存；删除任务会级联清除它的触发历史，而不是删除历史关联的会话或运行。参见[自动化任务与运行历史](../concepts/scheduled-tasks.md)。

## 工作区设置

`workspaceLayoutRepository` 在 `settings` 表中保存上次工作台位置、最近会话位置与布局。保存会话位置时，当前位置和最近会话在同一事务中记录；布局键独立持有侧栏宽度等默认值。可从[工作台导航与会话操作](../concepts/workspace-navigation.md)沿路由找到对应 UI。
