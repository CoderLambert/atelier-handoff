---
type: 功能工作流
title: Git 工作台与开发会话
description: 当前工作树中正在开发的 Git 状态浏览、会话工作树绑定和归档恢复方案。
tags: [git, worktree, development-session, snapshot]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-23T19:36:38.791Z
sources:
  - id: openwiki-source-2cef31e16708f13255c91a7d
    resource: repo://server/modules/git/development-worktrees.ts
  - id: openwiki-source-db8c7849088f24030135d2a4
    resource: repo://shared/git-workbench.ts
  - id: openwiki-source-c50b55a5c0abd94796c460a2
    resource: repo://tests/git-workbench.test.ts
generated: { by: "claude-code", at: "2026-11-23T19:36:38.791Z" }
---

# Git 工作台与开发会话

> 状态：以下内容描述 2026-11-24 工作区中未提交的实现和设计，**本次 Wiki 更新未运行验收测试**，不能视为已发布或已验收功能。实现可能继续变化。

Git 看板旨在读取本机分支、工作树、文件状态、暂存与未暂存差异及提交历史。开发会话可选择项目原目录或受管独立工作树，并绑定分支和基线提交。共享 schema 校验路径、引用、预览与创建请求；创建请求携带预期提交 ID，以便检测预览后基线变化。

## 归属与保护

Node 运行时负责 Git 操作和工作目录解析，SQLite 保存会话与受管工作树的绑定；没有绑定的旧会话仍使用项目原目录。实现检查仓库、目录和管理目录身份以及分支；重叠目录或同仓库 Git 操作受互斥保护。实际 Git 调用与用户手工 Git 环境分离，设计取舍见 `docs/decisions/2026-11-24-git-development-sessions.md`。

## 归档与恢复

设计采用数据根下的快照，区分暂存、未暂存及未跟踪内容，并在回收与恢复前检查目录及文件。被忽略文件、冲突、占用或无法验证的情况应保留目录而非假定可删除。`tests/git-workbench.test.ts` 包含真实本地 Git 的工作树、快照、恢复及迁移用例；本轮未执行这些用例，具体验收状态以功能开发记录为准。

相关导航见[工作台导航与会话操作](./workspace-navigation.md)。
