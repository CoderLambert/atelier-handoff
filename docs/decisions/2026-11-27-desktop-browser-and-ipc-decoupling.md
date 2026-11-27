# 桌面浏览器控制器拆分与可信 IPC 收口决策

## 背景

`desktop/browser/controller.mts`（801 行）同时承载了原生标签与外部网页窗口边界管理、3 条主进程 IPC 注册与注销、CDP 无障碍树快照及键盘鼠标注入、操作超时/取消/崩溃标签隔离恢复策略，且直接在构造阶段向全局 `ipcMain` 注册监听器而无对称解绑句柄。同时 `desktop/host/` 下 `ui-language-ipc.mts`、`ui-theme-ipc.mts`、`ui-notifications-ipc.mts` 重复编写了相同的 get/set 偏好查询、连接稳定性校验与 `isTrustedSender` 逻辑，`frontend/src/app/desktop-browser.tsx`（539 行）混杂了 Native Slot 监听观测和 11 层嵌套状态三元推导。

## 决策

1. **统一 host 偏好 IPC 与可信发送方注入**：
   - 在 `desktop/host/trusted-ipc.mts` 新增 `createTrustedSenderPredicate` 与 `bindTrustedPreferenceIpc`，收口 `ui-language-ipc.mts`、`ui-theme-ipc.mts` 与 `ui-notifications-ipc.mts` 的 `get`/`set` 校验、连接变更中止检查与对称取消绑定。
   - 严格遵守 `scripts/check-import-boundaries.mts`：`desktop/browser/*` 不导入 `desktop/host/*`，而是由 `BrowserHost` 接受可选 `isTrustedSender` 并由 `desktop/main.mts` 注入 `createTrustedSenderPredicate`。
2. **拆分 `desktop/browser/controller.mts` 与显式 `bindIpc()`**：
   - 新增 `desktop/browser/operation-lifecycle.mts`，封装 `BROWSER_STOP_GRACE_MS`、`createRendererGoneError()`、`BrowserOperationHandle`、`BrowserOperationContext` 与 `runBrowserOperation`，完整保留 `docs/decisions/2026-11-20-browser-timeout-recovery.md` 规定的 read-only 即时撤退、非 read-only 1 秒宽限期替换卡死标签、`verifyInput` 提醒与 `DESKTOP_BROWSER_TIMEOUT` / `DESKTOP_BROWSER_RENDERER_GONE` 错误语义。
   - 新增 `desktop/browser/cdp-driver.mts`，封装 `snapshotAccessibilityTree`、`executeCdpType`、`executeCdpClick` 与显式 `finally` 作用域守卫 `withExpectedKey` / `withExpectedMouse`。
   - 将 `controller.mts` 中 3 条 `ipcMain` 通道迁入显式 `bindIpc(): () => void`，由 `desktop/main.mts` 与隔离夹具显式绑定并在退出或重置时统一解绑。
3. **拆分 `DesktopBrowser` 观测与状态推导**：
   - 提取 `frontend/src/app/use-native-browser-slot.ts`（`boundsEqual`、`observeNativeBrowserSlot`、`useNativeBrowserSlot`）与纯函数模块 `frontend/src/app/desktop-browser-status.ts`（`deriveDesktopBrowserStatus`），替代深层嵌套三元表达式。

## 验证与回退

- **验证**：`npm run check`（含 `check:architecture` 与 `check:desktop`）、`npm run check:headers`、`npm run build`、`npm run build:desktop`；新增 `tests/desktop-browser-lifecycle.test.ts` 与 `frontend/src/app/desktop-browser-status.test.ts`；复跑 `desktop-*` 相关单测、完整 `npm test`，并在隔离环境中运行 `scripts/smoke-browser-cancellation.mts`、`scripts/smoke-shortcuts.mts` 与 `scripts/smoke-right-tool-panels.mts`。
- **回退**：若显式 `bindIpc()` 或生命周期拆分引发兼容问题，可将 `operation-lifecycle.mts` / `cdp-driver.mts` 内联回 `controller.mts` 并恢复各 `*-ipc.mts` 独立实现，对外部 IPC 协议和前端用户数据零格式变更。
