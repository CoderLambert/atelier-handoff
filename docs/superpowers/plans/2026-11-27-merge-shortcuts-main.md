# 快捷操作合入最新 main 实施计划

> **For agentic workers:** 按独立的 HTTP 与输入适配任务并行执行；主会话统一处理 Git、集成验收与远端更新。

**Goal:** 将 `feat/compact-workbench-layout@7e7467b` 合入 `main@7d40474`，保留 main 的 HTTP 模块拆分、Git 实时同步及输入性能优化。

**Architecture:** 复用现有快捷命令模块和共享配置；设置 API 接入 `server/http/settings/` 的领域路由，输入焦点请求经过现有会话组件传递到真实输入框。只调整合并产生的不兼容处。

**Tech Stack:** TypeScript、React、TanStack Query、Node HTTP、Drizzle SQLite、Electron。

**Spec:** [快捷操作决策](../../decisions/2026-11-26-workbench-shortcuts.md)、[HTTP 模块决策](../../decisions/2026-11-26-runtime-http-modules.md)及用户本轮合并请求。

## Global Constraints

- main 的 8 个新提交全部保留；不改变 SDK 执行语义和布局。
- 无新增依赖；使用 main 已锁定的 chokidar / readdirp。
- 保持 GET/PATCH `/api/settings/shortcuts`、配置版本、权限检查和 SQLite 键值兼容。
- 保留 main 的按会话窄订阅、稳定回调、按需 getDraft 和 Conversation memo；快捷焦点不恢复每次按键触发的历史区重渲染。
- Git 仅由主会话操作，远端 main 更新必须以已检查的头提交为前置条件。

## Review Focus

- HTTP 模块迁移后快捷设置请求仍经过同源、CSRF、桌面配对及 Zod 校验。
- 中文输入、连续编辑后立即切换会话、返回输入框时，草稿不丢失。
- main 的 React memo、窄订阅与草稿获取接口保留，不将快捷配置或导航状态引入历史区渲染依赖。
- 原生浏览器与终端打开、收起、恢复仍保留同一面板状态和运行实例。
- 合并过程中 main 若继续前进，重新检查差异，拒绝覆盖新提交。

## Task 1: HTTP 设置路由适配

**Files:** `server/app.ts`、`server/http/settings/routes.ts`、按需新增 `server/http/settings/shortcuts.ts`；`tests/shortcuts.test.ts`、`tests/runtime-http.test.ts`。

- [x] 依据 main 的组合入口恢复 `server/app.ts`，移除冲突中的旧路由实现。
- [x] 在设置领域接入现有配置仓储与 schema，保留精确路由匹配及返回格式。
- [x] 验证实际 HTTP GET/PATCH、无效输入、写入保护、重启持久化及独立设置键。

## Task 2: 输入框与会话组件适配

**Files:** `frontend/src/app/session-chat.tsx`、`frontend/src/features/chat/index.tsx`；按需扩展 `scripts/smoke-shortcuts.mts`。

- [x] 合并焦点请求属性与 main 的输入性能优化，保留 memo、事件回调和草稿保存时机。
- [x] 通过 TypeScript 与实际 Electron 流程验证快捷切换、连续编辑后的草稿保留和输入焦点。

## Task 3: 集成、审查与更新 main

- [x] 保留两侧阶段日志并记录本次适配与验证结果。
- [x] 执行仓库检查、测试与构建，保留环境限制和既有失败证据。
- [x] 独立审查合并结果；对本次适配的 7 份源码执行一次文件说明复核。

交付步骤：创建保留双方历史的合并提交，以已核对的远端 main SHA 作为更新前置条件；更新成功后再次核对远端提交及代码树。

## 执行记录

- 远端 main 为 `7d40474`，功能分支为 `7e7467b`，公共基线 `909d3b8`；工作区最初干净。
- 自动合并遇到四个冲突：HTTP 组合入口、Chat、SessionChat 和阶段日志；其余文件自动合并。
- HTTP 的 404 已用新增测试复现并修复；主干输入性能回归 5 项、实际工作台 11 场景及快捷核心/HTTP/会话回归 10 项通过。原生桥接 2 项和快捷 renderer 7 项通过。
- 全量诊断和环境限制如实记录在[合并验收](../../evidence/workbench-shortcuts/main-integration-2026-11-27.md)，不将有界诊断或定向通过记为全量全绿。
