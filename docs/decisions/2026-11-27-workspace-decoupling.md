# C4 · `Workspace` 职责解耦、浏览器状态下沉与 `query-legacy` 清退

## 问题与范围

[桌面工作台](../../openspec/roadmaps/build-atelier-desktop/roadmap.md)的 `frontend/src/app/workspace.tsx`（1,230 行）同时承担启动恢复与路由同步、右侧浏览器订阅/轮询、布局覆盖、三套互相独立的输入框聚焦通道、会话弹窗管理、运行控制和 15 项 `scripts/query-legacy.json` 豁免条目。`useDesktopBrowser` 与 `useBrowserPreview` 仅被右侧浏览器面板消费，挂在顶层导致每次原生浏览器标签、URL 或预览轮询更新都触发整个工作台、`Sidebar` 与 `SessionChat` 级联重渲染；传给 `SessionChat` 的内联回调进一步击穿 `Conversation = memo(...)`。此外，`localLayout` 写入后从未在保存成功时释放，永久遮蔽后续服务端布局更新。本轮仅调整渲染层工作区与查询边界，沿用现有 API、路由、快捷键与持久化契约。

## 取舍

- 遵循 [React 状态就近放置与重渲染隔离](https://react.dev/learn/managing-state)与 `<Activity mode="hidden">` 的副作用暂停语义，将 `useDesktopBrowser` 与 `useBrowserPreview` 下沉到 `BrowserPanel` 内部按桌面/Web 模式隔离挂载；右栏折叠时保留已有 `BrowserSlot` 清理与预览停询约定，切断浏览器高频状态向主工作台的重渲染传播。
- 遵循 [TanStack Query 查询边界](https://tanstack.com/query/latest/docs/framework/react/guides/queries)与仓库 `use-query/<领域>/` 约定，将 `bootstrap`、工作区缓存失效与 SSE 客户端接入收归 `frontend/src/use-query/workspace/`，将 `stopRun`/`retryRun`/`forkSession` 及幂等键下沉到 `SessionChat` 并使用 `useCallback` 稳定回调，同步清空 `scripts/query-legacy.json` 中 `app/workspace.tsx` 的全部豁免条目；`SessionChat` 保留可选回调覆写以兼容既有浏览器测试夹具。
- 遵循 [Redux Toolkit 单一工作台 UI 状态源](https://redux-toolkit.js.org/usage/usage-guide)，在 `workspace` slice 中统一为 `{ sessionId, requestId, caretToEnd? }` 聚焦信号（请求、确认、按会话清理），删除 `document.getElementById('prompt-input')` 越层 DOM 抓取、`inputFocus` 多层 props 透传与 `chat/index.tsx` 内部重复 `focusRequest` 状态。
- 拆分 `useWorkspaceNavigation`、`SessionManagementController` 与纯函数模块 `workspace-state.ts`；布局覆盖改为带递增 `requestId` 的 `PendingLayoutOverride`，仅在对应 `PATCH /api/settings/workspace-layout` 成功且无更新请求排队时释放，既保持拖拽零闪烁又不再永久遮蔽后续服务端布局更新。

## 验证与回退

以纯内存单测覆盖 Redux 聚焦信号流转、并发与单次布局覆盖释放、启动路由恢复及删会话后的落点选择；以 `npm run check`（含 `check:query`）、`npm run check:headers`、`npm run build`、`npm run build:desktop`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 及隔离 Wayland 真实 Electron 烟测（`smoke-right-tool-panels.mts`、`smoke-ordered-conversation.mts`）验证桌面面板生命周期、焦点交接、双语与中大屏布局。若出现浏览器槽位同步、焦点归还或工作区导航回归，直接回退 C4 提交即可，无需数据迁移。

```sh
NODE_OPTIONS=--test-isolation=none TSX_TSCONFIG_PATH=frontend/tsconfig.json node --import tsx --test frontend/src/features/inspector/workspace-state.test.ts
```
