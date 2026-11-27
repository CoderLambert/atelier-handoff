# Inspector 与 Sidebar 简化及独立提交状态决策

## 背景

1. `frontend/src/features/inspector/settings-page.tsx`（899 行）把三种提交模式（即点即存的 `Magpie` 开关、外部浏览器授权登录、与草稿表单共用「保存设置」按钮的网关/模型/执行上限）塞进同一 `<form>` 并共用 `busy` / `lock`，导致任一动作锁定全部 4 个 `<fieldset>`。
2. `frontend/src/features/inspector/run-trace.tsx`（536 行）在单次渲染中重复对 `events` 做 7 次线性查找/过滤，且在计算了 `automaticallyApproved` 集合后仍在 `tools.map` 中逐次重扫 `permissions.some(...)`。
3. `frontend/src/app/sidebar.tsx`（566 行）每次渲染都重建 `Intl.NumberFormat`、运行态映射 `bySession` 和 `new Date()`，并内联递归渲染整棵会话树与项目分页。

## 决策

1. **拆分 SettingsPage 独立交互卡片与纯校验**：
   - 提取 `frontend/src/features/inspector/settings-validation.ts`（`normalizeGatewayUrl`、`validateSettingsDraft`）统一网址、模型名、回合与超时校验。
   - 抽离 `BundledAccountCard`（`settings-account-card.tsx`）与 `MagpieToggleCard`（`settings-magpie-card.tsx`）到 `<form>` 外作为独立 `<fieldset className="settings-form-section">` 卡片，各自持有独立的 mutation / lock 与错误展示，不再与草稿 `<form>` 互锁。
2. **RunTrace 单趟事实汇总**：
   - 提取 `frontend/src/features/inspector/run-trace-facts.ts`（`mergeRunTraceEvents`、`scanRunTraceEvents`、`summarizeAutomaticApprovals`），对 `events` 和 `permissions` 各仅扫描一趟得出所有摘要字段与自动批准工具 ID 集合，消除重复线性扫描。
3. **Sidebar 记忆化拆分**：
   - 拆出 `React.memo` 包装的 `SidebarSearchBar`、`SidebarProjectGroup` 与 `SidebarSessionRow`，并在 `sidebar.tsx` 中用 `useMemo` / `useCallback` 稳定格式化器、运行态字典与交互回调。

## 验证与回退

- **验证**：`npm run check`（`check:architecture`、`check:query`、`check:i18n`、`check:ui`、`tsc`、desktop、tools）、`npm run check:headers`、`npm run build`、`npm run build:desktop`；新增 `frontend/src/features/inspector/inspector-simplification.test.ts` 验证纯校验与单趟轨迹提取；复跑 `settings-page.test.ts`、`inspector.test.ts`、`sidebar-projects.test.ts`、`session-tree.test.ts`、全量 `npm test` 及隔离 Wayland 真实 Electron 烟测 `scripts/smoke-ordered-conversation.mts`。
- **回退**：若设置表单卡片顺序或侧栏记忆化引发回归，可将卡片/行组件与事实函数内联回原文件，无后端契约或持久化格式变更。
