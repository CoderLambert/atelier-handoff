---
type: 运维与运行
title: 桌面端打包与运维构建
description: 开发桌面、Linux x64 打包输入、发布清单和独立安装态冒烟测试。
tags: [desktop, build, electron, linux, packaging, smoke-test]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-27T05:51:26.216Z
sources:
  - id: openwiki-source-754af1375ffae564bdab3544
    resource: repo://desktop/main.mts
  - id: openwiki-source-5ab468669f70351eaf5e6050
    resource: repo://openspec/roadmaps/build-atelier-desktop/roadmap.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-39a2636efc69030d51e32d63
    resource: repo://scripts/linux/package.mts
  - id: openwiki-source-9982f6639f97e28643d73aa5
    resource: repo://scripts/package-platform-preview.mts
  - id: openwiki-source-eb4663761189167522a9402e
    resource: repo://scripts/smoke-linux.mts
  - id: openwiki-source-c25b23396141a24d1ae248db
    resource: repo://server/db/connection.ts
generated: { by: "claude-code", at: "2026-11-27T05:51:26.216Z" }
---

# 桌面端打包与运维构建

## 开发版与托管网关

在项目根运行 `npm run desktop`。npm 先执行桌面类型检查、前端构建和桌面构建，再启动 Electron。Linux 开发桌面可使用打包输出中的 Shunt 二进制。桌面宿主负责启动网关、把连接信息交给运行时并在退出时清理网关。此处与[模型目录和发送路由](../integrations/model-gateways.md)对接。

## Linux x64 打包

`npm run package:linux` 先执行仓库检查和前端构建。打包脚本组装 Electron、Node、SDK 可执行文件、Shunt 和前端资源，生成 Arch pacman `.pkg.tar.zst` 与便携 `.tar.zst`。使用项目指定的 Node 和 Shunt 输入，可由 `ATELIER_BUILD_NODE` 与 `ATELIER_BUILD_SHUNT` 提供绝对路径。脚本核对版本、二进制或许可证的预期校验，并为 `dist/linux/` 输出发布清单及 `SHA256SUMS`。

## 跨平台候选

`scripts/package-platform-preview.mts` 为 Windows x64 和 macOS arm64 组装候选 ZIP，并检查目标平台 Node、Electron、SQLite 原生驱动及迁移资源。候选脚本显式枚举要核对的迁移文件，当前清单到 `0011-runtime-hotpath-indexes.sql`，不能据此认定 v12–v15 的自动化任务迁移已完成候选验收。候选构建也不等于目标系统安装、签名或真机验收；后续平台验收和发行按路线图安排。

## 验收入口

用 `npm run smoke:linux -- --help` 查看参数。`--app` 指向已安装的 `atelier`，脚本检查安装路径与资源，在隔离环境及独立状态下驱动窗口，并检查启动、运行时与退出清理。应用层的 `npm run check`、`npm test` 和 `npm run build` 是常规回归入口。实际发行验收与已覆盖平台以桌面路线图和执行日志为准。
