# atelier 桌面版执行日志

以[路线图](roadmap.md)为阶段索引，以[设计](design.md)为范围和决策依据。每项完成记录填写阶段、变更、验收命令、工件或证据路径、已知限制和回退步骤。状态使用待实施、进行中、已验证、阻塞。完整功能验收后在该段加入简短的「开发过程 review」，记录可合并的任务、可复用的测试证据或可提前结束的排查，并写明下一轮调整。

## 2026-11-28 · 自动化任务模型配置同步（已验证）

- 编辑规则时提交模型和推理强度，清除覆盖时提交 `null`。表单按运行时的顺序显示任务覆盖、目标会话模型或工作台默认。推理强度显示已保存的值、路由固定值或自动模式。
- `npm run check`、`npm run build` 与 `npm run build:desktop` 通过。隔离 Wayland Electron 使用回环目录验证中英文界面的继承、切换、保存、重载和清除覆盖。Node 24 前端测试 184 通过、1 跳过。后端 927 通过、6 跳过，HTTP 路径测试期望 403 实得 400，已在变更前的 HEAD 独立复现。验证日志在本地 `.local/schedule-model-verification/`。实际工作台已用原数据目录重新启动。
- 回退时撤销表单及其双语词条改动，重建前端并重新打开桌面。已有任务的模型字段沿用当前数据库格式。开发过程 review：先核对表单的保存请求和运行时回退顺序，再用一次桌面流程覆盖两个界面语言及持久化。

## 2026-11-27 · 机械护栏收紧与 `query-legacy.json` 清零（已验证）

- **`query-legacy.json` 彻底清零**：将最后 3 个遗留文件（`frontend/src/features/agents/{api,editor,index}.tsx`）的数据请求与强刷逻辑迁入 `frontend/src/use-query/agents/`（`keys.ts`、`use-agents.ts`、`use-agent-mutation.ts`、`use-start-agent-session.ts`），并在 `frontend/src/use-query/extensions/use-extensions.ts` 增加 `useFetchFreshExtensions`；将 `scripts/query-legacy.json` 清空为 `{}`，`npm run check:query` 确认 **0 legacy files tracked for migration**。
- **打破 `mcp-tools` 环并扩展模块无环与行数棘轮**：抽离 `server/modules/runs/mcp-tools/types.ts`（`RunMcpToolHost`、`ToolRegistration`）消除 `mcp-tools/index.ts <-> {checked-mcp,browser,builtin,extension}-tools.ts` 仅类型循环；扩展 `scripts/check-import-boundaries.mts` 的循环检查至 `desktop/host`、`shared` 与 `server/modules` 三个作用域，并为 C1–C10 重构的 13 个关键文件设置 `FILE_LINE_LIMITS` 行数棘轮（含 `server/app.ts <= 300`、`shared/types.ts <= 300`、`server/agent.ts <= 1500`、`workspace.tsx <= 960`、`conversation.tsx <= 300`、`editor.tsx <= 80` 等）；在 `tests/architecture-boundaries.test.ts` 新增 `shared`/`server/modules` 循环和行数棘轮 2 组用例。决策与回退见 `docs/decisions/2026-11-27-architecture-guardrails-and-query-zero.md`。
- **验证**：`npm run check`（`check:query` 打印 `0 legacy files tracked for migration`、`check:architecture` 全绿、`check:i18n`、`check:ui`、`tsc`、desktop、tools）、`npm run check:headers`（16 份源文件）与 `npm run build` / `npm run build:desktop` 全通过；`tests/architecture-boundaries.test.ts` **36/36** 全通过；主机 `ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 后端 **904/910** 通过、6 跳过、**0 失败**，前端首轮 **178/180** 通过、1 跳过（仅无关 `public-import-browser.test.ts` Chromium 启动竞争，单独串行复跑 **1/1** 通过）。未再重复运行桌面 Electron UI 烟测（本批未改动桌面浏览器宿主与 UI 布局），未用付费模型，未测系统包。
- **开发过程 review**：先以短小临时 AST 探测 `shared/` 与 `server/modules/` 现存环，精准发现仅存的 4 条 `mcp-tools` 桶循环后再加护栏，避免了规则上线后的全仓返工。至此架构评审清单中的 C1–C10 及配套机械护栏全部按计划收口并提交 `main`。

## 2026-11-27 · C10-B：独立设置卡片、`RunTrace` 单趟 Facts 与记忆化 `Sidebar`（已验证）

- **`SettingsPage` 独立提交解耦**：将即点即存的 `BundledAccountCard`（`settings-account-card.tsx`，76 行）与 `MagpieToggleCard`（`settings-magpie-card.tsx`，68 行）移出草稿 `<form>`，各自持有独立 mutation/lock 与错误状态，解除 4 个 `<fieldset>` 互锁；抽离纯校验模块 `settings-validation.ts`（86 行），`settings-page.tsx` 从 **899 行降至 790 行**，并在 `scripts/i18n-exceptions.json` 迁移 `Magpie` 品牌豁免文件路径。
- **`RunTrace` 单趟扫描与 `Sidebar` 记忆化拆分**：抽离 `frontend/src/features/inspector/run-trace-facts.ts`（111 行，`mergeRunTraceEvents`、`scanRunTraceEvents`、`summarizeAutomaticApprovals`）在单趟遍历中提取全部关键轨迹事件和自动审批集合，`run-trace.tsx`（536→541 行）直接复用；将 `frontend/src/app/sidebar.tsx`（**566 行降至 364 行**）拆为 `React.memo` 包装的 `sidebar-search-bar.tsx`（56 行）、`sidebar-session-row.tsx`（176 行）与 `sidebar-project-group.tsx`（188 行），并在父组件记忆化 `Intl.NumberFormat`、`runStatus`、`bySession` 及交互回调。决策与回退见 `docs/decisions/2026-11-27-inspector-and-sidebar-simplification.md`。
- **验证**：`npm run check`（`check:architecture`、`check:query`、`check:i18n`、`check:ui`、`tsc`、desktop、tools）、`npm run check:headers`（11 份 C10-B 源文件）与 `npm run build` / `npm run build:desktop` 全通过；新增 `frontend/src/features/inspector/inspector-simplification.test.ts` 与现行 `settings-page.test.ts`、`inspector.test.ts`、`sidebar-projects.test.ts`、`session-tree.test.ts` 定向合跑 **15/15 全通过**；主机 `ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 后端首轮 **891/898** 通过、6 跳过（1 个无关 Git 并行负载文件 `tests/git-multi-commit-api.test.ts` 单独串行重跑 **13/13** 全通过），`npm run test:frontend` **179/180** 通过、1 跳过、0 失败；隔离 Wayland 真实 Electron 烟测 `scripts/smoke-ordered-conversation.mts`（4 次回环 SDK 调用、507 文本片断、zh-CN/en 1280/1440/1920、新旧混排与 `RunTrace`）全通过（未用付费模型，未测系统包）。
- **已知限制**：`sidebar-project-group.tsx` 按 `bySession` 与 `unseenOutcomes` 整体 Map 引用驱动更新；当全局活动态字典变动时会刷新有可见项目，行级已由 `React.memo` 隔离未改动子树。
- **开发过程 review**：先读 `settings-page.test.ts` 与 `inspector.test.ts` 对照选择器与测试替身期望，未改动可访问命名即一次性通过全部 Chromium 用例；唯一小返工是 `RunEvent.type` 实为宽字符串、`Permission.status` 合法字面量为 `'allowed'` 及 `Magpie` 品牌豁免文件路径需迁至 `scripts/i18n-exceptions.json`，静态检查阶段立即暴露并修齐。下一轮完成最终机械护栏收紧（`query-legacy.json` 清零、`shared/` + `server/modules/` 循环检查与文件行数棘轮）。

## 2026-11-27 · C10-A：终端附件会话拆解、帧预序列化透传与 `search-skill-broker` 抽离（已验证）

- **终端会话与实例拆解**：将 `server/modules/terminal/manager.ts`（**841 行降至 650 行**）中的单连接快照围栏、`512/384/192 KiB` 双水位流控、单调帧序/ACK 校验与单次 JSON 序列化拆入 `server/modules/terminal/attachment-session.ts`（218 行，`TerminalAttachmentSession`），将 `outputChunks`、顺序异步队列、`pauses` 集合及统一状态谓词（`isTerminalClosedOrClosing` / `isTerminalRetained` / `isTerminalClosing` / `isTerminalRunning`）拆入 `server/modules/terminal/terminal-instance.ts`（137 行，`TerminalInstance`）；扩展 `TerminalConnection.send(frame, encoded?)` 与 `server/modules/terminal/transport.ts`（163 行），直接发送已测字节的预序列化 JSON 字符串，消除快照校验和下行输出热路径上的重复序列化。
- **搜索技能代理剥离**：将 `server/skill-package-execution.ts`（**532 行降至 297 行**）内嵌的 `@zhaopintong/multi-search-engine` 白名单校验、Unix socket HTTP 代理与结账地址改写逻辑迁入 `server/search-skill-broker.ts`（322 行）；`runPackagePython` 改为接收通用可选 `broker?: PackagePythonBrokerSpec`（保留 `search?: boolean` 兼容入口并消除 `!` 断言），`server/skill-package-runtime.ts`（109→105 行）显式注入 `createSearchSkillBrokerSpec` 并复用 `rewriteSearchCheckoutOutput`。决策与回退见 `docs/decisions/2026-11-27-terminal-session-and-skill-broker.md`。
- **验证**：`npm run check`（`check:architecture`、`check:query`、`check:i18n`、`check:ui`、`tsc`、desktop、tools）、`npm run check:headers`（8 份 C10-A 源文件）与 `npm run build` / `npm run build:desktop` 全通过；新增 `tests/terminal-attachment-and-broker.test.ts` 与全部 6 组现行终端/Skill 定向套件合跑 **40/40 全通过**；主机 `ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 后端首轮 **899/908** 通过、6 跳过（2 个无关 Git 并行竞争文件 `git-multi-commit-orphan-api.test.ts` 与 `git-commit-plan-recovery.test.ts` 单独串行重跑分别 **1/1** 与 **61/61** 全通过），`npm run test:frontend` **177/178** 通过、1 跳过、0 失败；隔离 Wayland 真实 Electron 烟测 `scripts/smoke-right-tool-panels.mts`（zh-CN/en 终端/Git/浏览器 450–1440 px、窄窗、全屏、收起恢复）通过（锁定依赖与真实 `node-pty`/Chromium，未用付费模型，未测系统包）。
- **已知限制**：后端 `test:skill-package-execution` 真实 `bwrap` 运行需在宿主 Linux 命名空间中执行（受限嵌套容器沙箱无 `bwrap` / 非同 UID `/tmp` 权限时会拒绝）。
- **开发过程 review**：先读全 `manager.ts` 和 `skill-package-execution.ts` 并保留 `search?: boolean` 与 `TerminalConnection` 重导出兼容层，使全部 40 项定向单测一次性 40/40 通过；重跑并行抖动 Git 测试时因误与前端套件并发启动导致 `git-commit-plan-recovery` 出现一次 `LocalGit.open` 竞争，彻底改为单文件串行后 61/61 全绿，后续复测只做纯串行重跑。下一轮进入 **C10-B（`SettingsPage` 表单解耦、`RunTrace` 单趟 Facts 与 `Sidebar` 记忆化，以及最终架构护栏收紧）**。

## 2026-11-27 · C9：桌面浏览器控制器拆分、`trusted-ipc` 收口与 `DesktopBrowser` 瘦身（已验证）

- **Host 偏好 IPC 与可信发送方注入**：在 `desktop/host/trusted-ipc.mts`（31→127 行）新增 `createTrustedSenderPredicate` 与 `bindTrustedPreferenceIpc`，收口 `ui-language-ipc.mts`（50→39 行）、`ui-theme-ipc.mts`（52→43 行）与 `ui-notifications-ipc.mts`（62→52 行）的通道校验、连接稳定性检查和对称解绑；`desktop/main.mts`（328→336 行）向 `createBrowserController` 注入 `isTrustedSender`，严守 `check:architecture` 中 `desktop/browser/*` 不直接导入 `desktop/host/*` 的边界。
- **浏览器控制器拆分与显式 `bindIpc()`**：从 `desktop/browser/controller.mts`（**801 行降至 674 行**）抽离 `desktop/browser/operation-lifecycle.mts`（156 行，`runBrowserOperation` 保留 read-only 即时取消、1 秒宽限替身与 `verifyInput` / `DESKTOP_BROWSER_TIMEOUT` / `DESKTOP_BROWSER_RENDERER_GONE` 语义）和 `desktop/browser/cdp-driver.mts`（216 行，`snapshotAccessibilityTree`、`executeCdpType`、`executeCdpClick` 与 `finally` 保护的 `withExpectedKey`/`withExpectedMouse`）；将 3 条 `ipcMain` 注册收入显式 `bindIpc(): () => void`，并在 `desktop/main.mts`、`tests/fixtures/workbench-shortcuts-app.ts` 与 `tests/fixtures/desktop-shortcuts-app.ts` 对称绑定与清理。
- **`DesktopBrowser` 观测与状态推导抽离**：拆分 `frontend/src/app/desktop-browser.tsx`（**539 行降至 404 行**）为 `frontend/src/app/use-native-browser-slot.ts`（133 行，`boundsEqual`、`observeNativeBrowserSlot` 与 `useNativeBrowserSlot`）与 `frontend/src/app/desktop-browser-status.ts`（78 行，纯函数 `deriveDesktopBrowserStatus` 替代 11 层嵌套三元表达式）。[决策与回退](../../../docs/decisions/2026-11-27-desktop-browser-and-ipc-decoupling.md)
- **验证**：`npm run check`（`check:architecture`、`check:query`、`check:i18n`、`check:ui`、`tsc`、desktop、tools）与 `npm run check:headers`（15 份 C9 源文件）及 `npm run build` / `npm run build:desktop` 全通过；新增纯 Node 生命周期/CDP 单测 `tests/desktop-browser-lifecycle.test.ts`（5/5 通过）及定向 desktop 组 `17/18` 通过、1 跳过（`desktop-shortcuts` 需 `Xvfb`），新增状态/坐标单测 `frontend/src/features/inspector/desktop-browser-status.test.ts`（2/2 通过）；`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 后端首轮 **877/886** 通过、6 跳过（2 个未改动的 Git 并行负载抖动文件 `git-commit-plan-execution.test.ts` 与 `git-multi-commit-api.test.ts` 单独重跑 **44/44** 通过），`npm run test:frontend` **177/178** 通过、1 跳过、0 失败；隔离真实 Electron 烟测 `scripts/smoke-shortcuts.mts`（12/12 项）与 `scripts/smoke-right-tool-panels.mts`（zh-CN/en 终端/Git/浏览器）全通过（使用真实 Electron、锁定 SDK 与隔离配置，未用付费模型，未测系统包）。
- **已知限制**：本机未安装 `/usr/bin/Xvfb`（仅有 `/usr/bin/Xwayland`），`scripts/smoke-browser-cancellation.mts` 与 `tests/desktop-shortcuts.test.ts` 中依赖 `Xvfb` 的交互式 30 秒真实 X11 输入测试未在本机执行，改以 `tests/desktop-browser-lifecycle.test.ts` 替身验证生命周期与定时器边界；完整真机 `Xvfb` 取消回归需在含 `xorg-server-xvfb` 环境补跑。
- **开发过程 review**：先核对 Batch 0 已完成的 `createTrustedIpcGuard`、`desktop-browser` 去 `!` 与局部 `MutationObserver`，避免重复施工；仅在 `runTool` 返回类型显式收窄为 `{ text: string; png?: undefined } | { png: string; text?: undefined }` 处有一次类型适配。下一轮进入 **C10（高性价比模块简化：终端管理、`SettingsPage` / `RunTrace`、`Sidebar` 与 `search-skill-broker`）**。

## 2026-11-27 · C5：Git 安全 I/O 收口、`WorktreeLeaseManager` 与多提交前端瘦身（已验证）

- **后端收口与去重**：新建 `server/modules/git/git-safe-io.ts`（148 行，收口 `OPEN_REGULAR_READ_FLAGS`、`OPEN_DIRECTORY_FLAGS`、`errnoIs`、`sameInode`、`statIdentity`、`readRegularFileSafely`、`readHeadTarget`、`verifyCheckoutDirectories`）并接入 `commit-journal.ts`、`commit-plan-snapshot.ts`、`commit-plan-execution.ts` 与 `commit-plan-recovery.ts`；在 `shared/git-multi-commit.ts` 导出 `MAX_MULTI_COMMIT_GROUPS = 120` 并将导入从 `./types.js` 迁至 `./models.js`，统一替换分散的 `120` 上限（`commit-journal.ts`、`commit-plan-execution.ts`、`commit-plan-revision.ts`、`commit-analysis-sessions.ts`、`commit-operation-repository.ts`）；从 `commit-plan-coordinator.ts`（**249 行降至 233 行**）删除重复的 `CommitPlanRecoveryCoordinator`，从 `commit-journal.ts` 导出 `isLegalJournalAdvance` 统一 `commit-plan-coordinator.ts` 与 `commit-plan-recovery.ts` 的状态推进判断。
- **工作树租约与幂等模板**：提取 `server/modules/git/worktree-lease-manager.ts`（56 行，`WorktreeLeaseManager` 与 `directoriesOverlap`）接管 `development-worktrees.ts` 独占路径/仓库锁与终端目录预留，并将 `create`/`reclaim`/`restore` 三段双重检查幂等回放收口为单一 `runIdempotentWorktreeOp` 模板（927→939 行）。[决策与回退](../../../docs/decisions/2026-11-27-git-safe-io-and-multi-commit-slimming.md)
- **前端多提交与历史视图瘦身**：拆出 `hooks/use-git-multi-commit-model-selection.ts`（84 行）并重构 `hooks/use-git-multi-commit-review.ts`（**600 行降至 543 行**，单一 `BusyPhase`、`runExclusive` 与 `handlePlanError`，消除非空断言 `!`）；拆分 `git-multi-commit-editor.tsx`（**1,115 行降至 380 行**）为 `git-multi-commit-types.ts`（103 行）、`git-multi-commit-group-list.tsx`（184 行）、`git-multi-commit-inventory.tsx`（528 行）和 `git-multi-commit-footer.tsx`（145 行），移除父层 130 行 `GitMultiCommitEditorMessages` 注入并将 `git-multi-commit-dialog.tsx` 从 **630 行降至 499 行**；从 `git-views.tsx`（741→734 行）移除 `GitHistoryView` 薄包装，改由 `git-history/git-history-view.tsx` 提供默认 `feedbackRenderer` 并由 `index.tsx` 直接导入。
- **验证**：`npm run check`（`check:architecture`、`check:query`、`check:i18n`、`check:ui`、`tsc`、desktop、tools）与 `npm run check:headers`（24 份 C5 源文件）及 `npm run build` / `npm run build:desktop` 全通过；新增 `tests/git-safe-io-and-leases.test.ts` **4/4** 通过；定向 7 组现有后端 Git 测试在含新单测的 194 项合跑中全部通过（仅首次修正新单测 `GIT_DIRECTORY_BUSY` 错误码）；全量 `ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 一次性全绿：**892/898** 后端通过、6 跳过、0 失败，前端 `npm run test:frontend` **175/176** 通过、1 跳过、0 失败；隔离 Wayland 真实 Electron 烟测 `smoke-right-tool-panels.mts` 与 `smoke-git-live-sync.mts` 全通过（使用锁定 SDK、系统 Git 与隔离回环模型，未用付费模型，未测系统安装包；`smoke-git-workbench.mts` 为安装包验收脚本未构包运行）。
- **已知限制**：`git-multi-commit-inventory.tsx`（528 行）和 `use-git-multi-commit-review.ts`（543 行）仍属较聚焦的单域模块，当前满足功能与边界清晰度；后续护栏收紧时如设定更低行数阈值可再拆表格行或预览渲染子项。
- **开发过程 review**：先完成后端安全 I/O 与租约收口并跑 `tsc && check:architecture` 验证，再拆分前端 Hook 与 UI 组件，避免了跨端联调返工；`check-i18n` 对静态查找表 `title` 属性名的硬编码误报与 `gitError` 加 `GIT_` 前缀的测试断言各修正一次即绿，无需重跑已通过的历史回归。下一轮进入 **C9（前端/IPC/Electron 与其余超大模块收敛）**。

## 2026-11-27 · C7：拆分 `shared/types.ts`、统一扩展校验契约并拆解 `ExtensionEditor`（已验证）

- 拆分 `shared/types.ts`（**475 行降至 274 行**）为无环分域模块：`shared/errors.ts`（17 行，零依赖 `AppError`/`now`）、`shared/agents.ts`（89 行，零依赖 `Mode` 与智能体契约）、`shared/models.ts`（62 行，模型目录 Zod 校验）、`shared/extensions.ts`（428 行，扩展类型、`GithubSkillVersion`、前后端单一 `extensionInputSchema`/`validateExtensionInput` 与结构化诊断分类 `classifyExtensionDiagnostic`/`extensionDiagnosticMessages`）；`shared/public-extensions.ts` 改为直接从 `extensions.ts` 引用，打破 `types <-> public-extensions` 互相导入；`shared/types.ts` 保留 `export *` 兼容导出；将 52 个仅用 `AppError`/`now` 的生产文件迁至 `shared/errors.js`，使 `shared/types` 生产导入方从 **243 降至 188**（共减少 55 处）。`server/extensions.ts` 复用共享校验与诊断消息常量；`frontend/src/features/extensions/api.ts` 改由 `classifyExtensionDiagnostic` 按码映射到 i18n。
- 迁出 `features/extensions/*` 全部遗留数据与缓存操作到 `frontend/src/use-query/extensions/`（`use-skill-tool-bindings.ts`、`use-save-skill-tool-bindings.ts`、`use-skillhub-search.ts`、`use-test-mcp-extension.ts` 及 `useExtensionPickerCatalog`、`useReadCachedSkillInheritance`），同步清空 `scripts/query-legacy.json` 中 `features/extensions/*` 4 个文件条目（`check:query` 遗留文件从 **7 降至 3**）。拆分 `frontend/src/features/extensions/editor.tsx`（**702 行降至 53 行**）为 `markdown-extension-form.tsx`（305 行）、`mcp-extension-form.tsx`（487 行）与 `validation.ts`（50 行），同步对齐 `shared/i18n/catalogs/extensions.ts` 中英文提示。决策与回退见 `docs/decisions/2026-11-27-shared-types-and-extensions-contract.md`。
- 验证：`npm run check`（`check:architecture`、`check:query` 仅剩 3 个文件、`check:i18n`、`check:ui`、`tsc`、desktop、tools）与 `npm run check:headers`（77 份变更/新增源文件，含顺手补齐 4 个原无文件头的服务端源文件）及 `npm run build` / `npm run build:desktop` 通过；新增 `tests/shared-extensions-contract.test.ts` 3 项与扩展 `extension-detail.test.ts`（双语校验错误提示）通过；定向 6 组后端 **59/59** 通过，扩展前端 33 项首轮 32/33 通过（`catalog-controls.test.ts` 焦点竞争单独重跑 **1/1** 通过）；全量后端测试 **826/834** 通过、6 跳过（2 个并行负载超时 `branch-feedback-sdk` 与 `git-commit-plan-recovery` 单独重跑 **62/62** 通过，`tests/attachment-document-reader.test.ts` 已更新最小打包闭包的 `shared/errors.ts` 并单独验证 **26/26** 通过）；前端全量 `npm run test:frontend` **175/176** 通过、1 跳过、0 失败；隔离 Wayland 真实 Electron 烟测 `smoke-ordered-conversation.mts` 与 `smoke-right-tool-panels.mts` 通过（锁定 SDK + 回环模型，未用付费模型，未测系统包）。
- 已知限制：尚有 188 个生产文件通过 `shared/types.ts` 兼容桶导入核心工作台或其他类型（未一次性全仓迁移）；旧版已存储的不合规扩展记录不自动改写，仅在再次保存时按统一契约校验。
- **开发过程 review**：先用 AST 精确统计并替换 `AppError`/`now` 单一依赖，避免了正则跨行误伤；同时 `check:query` 规则强制单文件单 Hook 立即暴露了合写问题并拆分完成。唯一返工来自 `tests/attachment-document-reader.test.ts` 硬编码了独立打包入口 `'shared/types.ts'`，下一轮改动 `shared/` 导入路径前先全文搜索硬编码 esbuild 入口清单即可一次改齐。

## 2026-11-27 · C6：待处理消息迁入 Drizzle、统一中断恢复与热路径索引查询（已验证）

- 新增 v11 迁移 `0011-runtime-hotpath-indexes.sql`（`runs.status`、`tools`/`permissions`/`artifacts` 的 `run_id` 与 `status` 派生列及 6 个 B-tree 索引），`MessageQueue` 全部 17 处手写 SQL 迁入 `server/db/repositories/message-queue.ts`（`database-legacy.json` 清除 `server/message-queue.ts`），新增 `server/db/repositories/runtime-records.ts` 具名查询并替换 `execution-slots`、队列调度/动作、`create-run`、`permissions`、运行详情路由与 `agent.ts` 收尾中的 `store.list(...).filter(...)`。`server/modules/runs/recovery.ts` 将子任务、队列、工具、审批与运行恢复并入同一事务；`Store` 改为 `repos` 组合加迁移注册表，`LATEST_SCHEMA_VERSION=11`。决策与回退见 `docs/decisions/2026-11-27-orm-queue-and-hotpath-queries.md`。
- 验证：`npm run check`、`npm run check:headers`（27 份源文件）、`npm run build`、`npm run build:desktop` 通过；定向 7 组 149 项在修正 v9 迁移用例的目标版本后通过；新增 `tests/runtime-orm-queries.test.ts` 4 项（v10→v11 升级与失败回滚、9 条查询计划无 `SCAN`、恢复故障整体回滚且幂等、队列语义对照）通过；完整 `npm test` 运行时 868/877 通过、6 跳过，3 个并行负载失败（`builtin-rtk-packaging`、`gateway-models`、`git-multi-commit-api`）单独重跑 26/26 通过；前端 174/175、1 跳过、0 失败；隔离 Wayland 真实 Electron 烟测 `smoke-ordered-conversation.mts`、`smoke-subagents.mts` 通过（锁定 SDK + 回环模型，未用付费模型，未测系统包）。
- 已知限制：未新增按会话复合索引（沿用 `runs_snapshot_session`）；`finalizeUnfinishedRunTools` 保持原语义，不改写非 Bash 之外的 `bashExecution`；升级后旧版程序会拒绝 v11 库，需用升级前备份回退。
- **开发过程 review**：计划阶段先确认只改写 v1–v5 之外的 SQL，避免历史指纹漂移；查询计划测试提前发现冗余复合索引并删除。下一轮在改 schema 时先建共享降级夹具 `tests/fixtures/downgrade-v11.ts` 再改测试，避免逐文件补漏；全量测试先看并行负载失败是否可单独复现。

## 2026-11-27 · C8：消除 `SubagentRun` / `NativeBashTasks` / `agent.ts` 三方状态镜像（已验证）

- 提取 `server/modules/runs/tool-invocation-gate.ts`（`ToolInvocationGate` + `callHash` + `ProjectWrites`，`subagent-run.ts` 保留 `ProjectWrites` 重导出），将主会话与子代理共用的 MCP 一次性票据和目录写锁移出 `SubagentRun`；将 `branchControllers` 收归 `SubagentRun`（`ensureBranchSignal` / `branchSignal` / `stop` 及 `finish`/`close` 自动中止），保持先 `sdk.stopTask` 再中止本地控制器的顺序；提取 `server/modules/runs/sdk-task-coordinator.ts` 统一 `local_agent` / `local_bash` SDK 任务帧 Zod schema 与单一 `runningTools` / `foregroundTools()` / `canBackground()` / `backgroundTool()` 视图，`LiveTurnCoordinator` 改为消费统一的 `SdkTaskCoordinationView`（保留测试构造兼容路径）；提取无状态 `server/tool-evidence.ts`，使 `server/session-checkpoint.ts` 不再依赖 `HarnessProgress` 状态机（`server/harness-progress.ts` 从 **743 行降至 509 行**，`server/agent.ts` 从 **1,497 行降至 1,467 行**，`server/subagent-run.ts` 从 **295 行降至 259 行**，`server/native-bash.ts` 从 **294 行降至 276 行**）。[决策、验证和回退](../../../docs/decisions/2026-11-27-subagent-task-coordination.md)
- `npm run check`、`npm run check:headers`（10 份变更/新增源文件）、`npm run build`、`npm run build:desktop` 及定向测试 6 组 **61/61 全通过**（含新增 `tests/sdk-task-coordinator.test.ts` 5 项纯内存用例及真实 SDK `subagents.test.ts`、`native-bash-control-sdk.test.ts`、`native-subagent-insertion-sdk.test.ts`）；全量 `ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 运行时 886 项首轮 **879 通过、6 跳过**（仅无关并行计时项 `tests/terminal-process.test.ts` 1 项超时，单独复跑 **3/3 通过**），前端 `npm run test:frontend` **174 通过、1 跳过、0 失败**（175 项）。
- 隔离 Wayland 真实 Electron 烟测两项全通过：`node --import tsx scripts/smoke-subagent-insertion.mts`（中英文 `Ctrl+Enter` 与队列插话、双前台子代理后台交接与二次插话、隔离回环模型）及 `node --import tsx scripts/smoke-subagents.mts`（16 次回环 SDK 请求、多分支审批与单分支停止）。未使用付费模型验证，未验收系统安装包，未切换日用桌面实例。
- **开发过程 review**：先检查第 0 批提交 `80461bc` 确认 `secret-redaction.ts` 与死代码清理已先完成，避免了重复动作；在 `sdk-task-coordinator.ts` 用 `import type` 隔离 `SubagentRun`/`NativeBashTasks` 并将 `LiveTurnCoordinator` 构造保持向后兼容，使 C8 一次性通过全部架构边界、真实 SDK 回环测试和 Electron 子代理烟测，无返工。下一轮建议按既定清单推进 **C6（落地 ORM ADR 第 3 步：`store.ts` 瘦身与 `message-queue` 迁 Drizzle）** 或 **C5 / C7**。

## 2026-11-27 · C4：`Workspace` 外壳瘦身、浏览器状态下沉与 `query-legacy` 清退（已验证）

- 将 `useDesktopBrowser` 与 `useBrowserPreview` 下沉到 `frontend/src/app/panels/browser-panel.tsx`（拆分为 `DesktopBrowserPanel` / `WebBrowserPreviewPanel` 边界），切断原生浏览器标签/URL 与 Web 预览轮询向 `Workspace`、`Sidebar`、`SessionChat` 的级联重渲染，同时保留 `<Activity mode="hidden">` 下的 `BrowserSlot` 清理与预览停询约定；抽出 `workspace-state.ts`（纯路由/启动恢复/删会话回退/带 `requestId` 的布局覆盖状态机）、`use-workspace-navigation.ts` 与 `session-management-controller.tsx`，将 `stopRun`/`retryRun`/`forkSession` 及幂等键下沉到 `session-chat.tsx` 并用 `useCallback` 稳定透传给 `Chat` / `Conversation = memo(...)` 的回调。新增 `frontend/src/use-query/workspace/`（`use-bootstrap.ts`、`use-workspace-cache.ts`、`use-workspace-events.ts`），同步清空 `scripts/query-legacy.json` 中 `app/workspace.tsx` 的全部 15 项遗留豁免（`check:query` 追踪遗留文件降至 7 个）；收敛三套输入框聚焦通道（删除 `getElementById('prompt-input')` 越层抓取、`inputFocus` 多层 props 透传与 `chat/index.tsx` 内部 `focusRequest` state）为 Redux `workspace` slice 单一 `{ sessionId, requestId, caretToEnd? }` 信号；修复布局覆盖在 `PATCH /api/settings/workspace-layout` 成功且无更新请求排队时释放，不再永久遮蔽后续服务端布局更新。`frontend/src/app/workspace.tsx` 从 **1,230 行降至 926 行**（净减 304 行）。[决策、验证和回退](../../../docs/decisions/2026-11-27-workspace-decoupling.md)
- `npm run check`（含 `check:architecture`、`check:query`、`check:i18n`、`check:ui` 及四组 `tsc`）、`npm run check:headers`（14 份变更/新增源文件）、`npm run build`、`npm run build:desktop` 全通过；`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 运行时 881 项首轮通过 **874 通过、6 跳过**（仅并行争抢抖动项 `tests/git-commit-plan-snapshot.test.ts` 1 项失败，单独无争抢复跑 **18/18 通过**），前端 `npm run test:frontend` **174 通过、1 跳过、0 失败**（175 项，含新增 `workspace-state.test.ts` 5 项纯内存用例及真实 Chromium `workspace-panels.test.ts`、`message-actions.test.ts`、`inheritance-browser.test.ts`、`ordered-transcript.test.ts`、`subagents.test.ts`）。
- 隔离 Wayland 真实 Electron 烟测三项全通过：`node --import tsx scripts/smoke-right-tool-panels.mts`（中英文终端/Git/浏览器 450–1440 px、窄窗、全屏、收起与恢复）、`node --import tsx scripts/smoke-ordered-conversation.mts`（锁定 SDK、隔离回环模型、反序工具完成、507 文本片段、SSE 断线重连、停止恢复、新旧混排与双语 1280/1440/1920）及 `node --import tsx scripts/smoke-shortcuts.mts`（12/12 项快捷键与聚焦交接检查，含窄窗浏览器→输入框聚焦与 IME Esc）。未使用付费模型验证，未验收系统安装包，未切换日用桌面实例。
- **开发过程 review**：先读 `check-query-boundaries.mts` 源码和 `message-actions.test.ts` / `workspace-panels.test.ts` 夹具约束，直接保留了 `SessionChat` 的可选回调覆写与 `useRunEvents(client, ...)` 签名，避免引入测试适配返工；全量 `npm test` 并发运行期间仍有零星 `git-commit-plan-snapshot.test.ts` / `builtin-rtk-sdk.test.ts` CPU 争抢抖动，复跑即绿，后续若在 C5 触及 Git 模块可顺手检查临时索引锁耗时。

## 2026-11-27 · C3：`Conversation` 双轨收口与流式热路径优化（已验证）

- 提取 `conversation-turns.ts`（`buildConversationTurns` 单趟 `O(N)` 按运行线性归并快照与轮次比较器）、`use-auto-follow-scroll.ts`（以 `data-preserve-scroll` 替代硬编码 CSS 选择器）、`conversation-turn-parts.tsx` / `legacy-message-turn.tsx` / `run-progress.tsx`（统一 Ordered 与 Legacy 的用户气泡、消息页脚、`BrowserToolNotice`/`RunResult`/交付物）及 `features/inspector/run-inspector-dialogs.tsx`（对话与执行轨迹共用弹窗宿主）；窄化 `OrderedRun`、`LegacyMessageTurn`、`groupRunWork` 与 `permissionSubagentSource` 的数据切片并用 `React.memo` 隔离历史轮次，消息操作改为消费稳定布尔 `hasSubsequent` 避免末条外历史消息被新增消息击穿，`conversation.tsx` 从 **1,042 行降至 266 行**，继续沿用 `run-stage.ts` 的 `deriveRunStage` 与 `toolLabel`。[决策、验证和回退](../../../docs/decisions/2026-11-27-conversation-turns-and-hot-path.md)
- `npm run check`、`npm run check:headers`、`npm run build`、`npm run build:desktop` 全通过；`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 全通过：运行时 **875 通过、6 跳过、0 失败**（881 项），前端 **169 通过、1 跳过、0 失败**（170 项，含新增 `conversation-turns.test.ts` 5 项纯内存用例及真实 Chromium `ordered-transcript.test.ts` / `inspector.test.ts` / `subagents.test.ts`）。
- 隔离 Wayland 真实 Electron 烟测 `node --import tsx scripts/smoke-ordered-conversation.mts`（锁定 SDK、隔离回环模型、反序工具完成、507 文本片段、SSE 断线重连、停止恢复、新旧对话混排与双语 1280/1440/1920）通过。未使用付费模型验证，未验收系统安装包，未切换日用桌面实例。
- **开发过程 review**：Codex（`gpt-6.2-sol` + `medium`）在明确沙箱限制的精简 brief 下一次完成拆分与纯内存比较器单测，主会话仅串行执行一轮完整 check/build/test 与真实 Electron 烟测即一次性全绿通过，无返工；下一轮按同一分工继续推进 **C4（`Workspace` 瘦身、下沉浏览器状态与清退 `query-legacy`）**。

## 2026-11-27 · C2：`Composer` 与 `ExtensionPicker` 键盘归主与策略统一（已验证）

- 提取 `use-composer-keymap.ts`、`composer-policy.ts` 与 `composer-context.tsx`，将 `Enter` 提交、`Ctrl/Alt+Enter` 快捷插话与 IME 50 ms 保护归还 `Composer` 的 textarea，移除 `ExtensionPicker` 的原生捕获劫持、`onSubmit`/`onQuickInsert` props、无依赖 `useLayoutEffect` 与 `mode` 降级还原补丁；统一 `composer.tsx`、`session-chat.tsx`、`features/chat/index.tsx`、`message-queue.tsx` 的目录/模式/插话判定，并将 `drafts.ts` 与 `chat/index.tsx` 的引用去重/长度校验收敛进 `appendDraftQuote`。`composer.tsx` 从 688 行降至 587 行，`picker.tsx` 从 793 行降至 700 行。[决策与回退](../../../docs/decisions/2026-11-27-composer-picker-decoupling.md)
- `npm run check`、`npm run check:headers`（10 份变更/新增源文件）、`npm run build`、`npm run build:desktop` 全通过；`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm run test:frontend` **164 通过、1 跳过、0 失败**（含新增 `composer-policy.test.ts` 与真实 Chromium `picker-browser.test.ts` / `inheritance-browser.test.ts`）。
- 隔离 Wayland 真实 Electron 烟测 `node --import tsx scripts/smoke-subagent-insertion.mts`（中英文 `Ctrl+Enter` 快捷插话与队列插话、回环模型）通过。未使用付费模型验证，未验收系统安装包，未切换日用桌面实例。
- **开发过程 review**：移除 `picker.tsx` 无依赖 `useLayoutEffect` 后弹窗关闭渲染提速，暴露出 `inheritance-browser.test.ts:268` 对 Radix 异步焦点归还的同步断言竞态；另 `picker-browser.test.ts` 替换 textarea 后在 Chromium 默认光标为 0 需先按 `End`。主会话真实 Chromium 复跑第一时间定位并修正了这两处测试夹具。

## 2026-11-27 · C1 第 4 步（C1 收官）：运行环境、子进程托管与终态判定拆分（已验证）

- 提取 `createRunProcessOwner`（`server/modules/runs/run-process-owner.ts`）统一 native `createHarnessProcess` 与非 native 子进程启停及 1 秒/8 秒取消清理；提取 `RunEnvironment` / `buildInitialPrompt`（`server/modules/runs/run-environment.ts`）收拢临时目录、Skill/RTK 挂载与 Shunt/OTLP 释放顺序；提取扁平守卫纯函数 `resolveRunOutcome()`（`server/modules/runs/run-outcome.ts`）替代 9 层嵌套三元。`server/agent.ts` 从 1,763 行降至 1,497 行（相对最初 2,953 行累计净减 1,456 行 / 49.3%），`Runner` 接口与构造签名不变。[决策与回退](../../../docs/decisions/2026-11-27-run-environment-and-outcome.md)
- `npm run check`、`npm run check:headers`（4 份变更/新增源文件）、`npm run build`、`npm run build:desktop` 及 Prettier 全通过；`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 运行时 881 项在 `task-363` 首轮全部通过（含新增 `tests/run-outcome-and-process.test.ts` 17 项用例与真实 SDK 0.3.332 回环测试），无并发争抢复跑 `project-markdown-skills.test.ts` + `git-commit-plan-snapshot.test.ts`（21/21）、前端 154 通过 + `picker-browser.test.ts` 单独复跑 1/1 通过。
- 隔离 Wayland 真实 Electron 烟测 `node --import tsx scripts/smoke-sdk-request-timing.mts`（中英文 OTLP 请求计时、导出及重开恢复、隔离回环模型）通过。未使用付费模型验证，未验收系统安装包，未切换日用桌面实例。
- **开发过程 review**：C1 沿「MCP 工具 → 实时插话协调器 → 转录账本 → 环境/子进程/终态」4 个独立提交渐进拆分，每步均以真实 SDK 回环测试和针对性 Electron 烟测验收，零回归将 `agent.ts` 砍半并新增 55 项纯内存确定性单测；并行重启时需避免两轮全量测试同时跑抢占 CPU/内存。

## 2026-11-27 · C1 第 3 步：转录账本与通知补位拆分（已验证）

- 提取 `RunTranscriptLedger`（`server/modules/runs/run-transcript-ledger.ts`），将原外泄在 `server/agent.ts` 闭包中的 `RunTranscript`、`transcriptNotices`、`recordedNotices`、`pendingDenials`、`seenTools`、`unpositionedTools` 及 80 ms 节流刷盘收敛为单一不变量所有者，`server/agent.ts` 从 1,872 行降至 1,763 行（净减 109 行）。收尾保留原有时序，`Runner` 接口与构造签名不变。[决策与回退](../../../docs/decisions/2026-11-27-run-transcript-ledger.md)
- `npm run check`、`npm run check:headers`、`npm run build`、`npm run build:desktop` 及 Prettier 全通过；`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 运行时 838 通过、5 跳过（含新增 `tests/run-transcript-ledger.test.ts` 7 项纯内存用例与真实 SDK 0.3.332 回环测试），两处无关并行抖动项（`builtin-rtk-sdk.test.ts`、`git-multi-commit-api.test.ts`）单独复跑 36/36 通过；前端 155 通过、1 跳过。
- 隔离 Wayland 真实 Electron 烟测 `node --import tsx scripts/smoke-ordered-conversation.mts`（锁定 SDK + 隔离回环模型、反序工具完成、507 文本片段、重连重开及双语 1280/1440/1920）通过。未使用付费模型验证，未验收系统安装包，未切换日用桌面实例。
- **开发过程 review**：账本与持久化通过窄宿主接口解耦后，Hook 先于流帧补位、`pendingDenials` 转正和 80 ms 节流刷盘均可纯内存单测，配合真实 Electron 有序对话烟测一次通过；下一步进入 C1 收官第 4 步（`RunEnvironment` + `RunProcessOwner` + `resolveRunOutcome()`）。

## 2026-11-27 · C1 第 2 步：实时插话与输入排空拆分（已验证）

- `LiveTurnCoordinator`（`server/modules/runs/live-turn-coordinator.ts`）接管 SDK 输入队列、插话槽、前台 Agent/Bash 后台交接、SDK 回执与 120 秒空闲结算，运行宿主负责原有消息持久化、助手占位和事件。原生模式继续等待同一 SDK 会话的 `idle`，受控模式沿用模型状态判定。`server/agent.ts` 从 2,102 行减至 1,872 行（净减 230 行），`Runner` 和 `AgentRunner` 构造签名不变。[决策与回退](../../../docs/decisions/2026-11-27-live-turn-coordinator.md)
- 主会话复核通过 `npm run check`、`npm run check:headers`、`npm run build`、`npm run build:desktop` 及 Prettier；`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 运行时 850 通过、6 跳过（含新增 `tests/live-turn-coordinator.test.ts` 17 项纯内存用例与真实 SDK 0.3.332 回环测试），前端 154 通过、1 跳过，两处并行计时抖动项（`conversation-transcript-sdk.test.ts` 与 `catalog-controls.test.ts`）单独复跑均全通过。
- 隔离 Wayland 真实 Electron 烟测 `node --import tsx scripts/smoke-subagent-insertion.mts`（中英文 `Ctrl+Enter` 与队列插话、双前台子代理后台交接与二次插话、隔离回环模型）全部通过。未使用付费模型验证，未验收系统安装包，未切换日用桌面实例。
- **开发过程 review**：将定时器与任务交接注入 `LiveTurnCoordinator` 内存夹具后，120 秒空闲结算、前台工具动态变化与排空条件全部可毫秒级确定性单测，配合真实 Electron 子代理插话烟测形成双层兜底；下一轮 C1 第 3 步继续独立抽离 `RunTranscriptLedger`。

## 2026-11-27 · C1 第 1 步：`server/agent.ts` MCP 工具注册与执行层拆分（已验证）

- 将 `server/agent.ts` 中的 `custom()` 与全部 MCP 工具注册/执行逻辑抽离至 `server/modules/runs/mcp-tools/`（`index.ts`、`checked-mcp.ts`、`builtin-tools.ts`、`browser-tools.ts`、`extension-tools.ts`），`server/agent.ts` 从 2,953 行降至 2,102 行（净减 851 行）；以统一 `invokeCheckedMcp()` 合并绑定 MCP 与外部 MCP 的 64 KiB 参数上限、审批和三处复核逻辑，并用显式守卫替换外部工具定义查找的非空断言。对外 `Runner` 接口、SDK 主循环、工具名称/描述/schema 及全部事件语义不变。[决策与回退](../../../docs/decisions/2026-11-27-run-mcp-tools.md)
- `npm run check`、`npm run check:headers`（6 份变更/新增源文件）、`npm run build`、`npm run build:desktop` 及 Prettier 检查全部通过；`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 运行时 833 通过、6 跳过，唯一并行超时项 `tests/harness-process.test.ts` 单独复跑 11/11 通过（含新增 `tests/run-mcp-tools.test.ts` 14 项确定性单测与真实 Claude Agent SDK 0.3.332 回环测试）；前端 155 通过、1 跳过。
- 隔离 Wayland 真实 Electron 烟测 `node --import tsx scripts/smoke-ordered-conversation.mts`（锁定 SDK + 隔离回环模型、中英文 1280/1440/1920）通过。未使用付费模型验证，未验收系统安装包，未切换日用桌面实例。
- **开发过程 review**：按「仅拆离 MCP 工具注册/执行接缝、不动主循环与流控」单步委派 Codex（`gpt-6.2-sol` + `high`），在严格保持 24 处工具定义与测试零回归的前提下一次削减 851 行并补齐 14 项纯内存单测；后续 C1 第 2 步继续按同一节奏独立抽离 `LiveTurnCoordinator`。

## 2026-11-27 · 架构体检第 0 批 Quick Wins（已验证）

- 修复并收敛 6 项现存缺陷与漂移：① `frontend/src/features/extensions/api.ts` 消除重复中文 Map 键覆盖，在 `public-import.tsx` 按 `'github-preview'` 场景保留停用提示；② 提取 `desktop/host/trusted-ipc.mts` 统一 5 个宿主 IPC 的来源守卫，并为 `desktop/host/files.mts` 补齐 `isStopping()` 检查；③ `frontend/src/app/desktop-browser.tsx` 抽出 `observeNativeBrowserSlot`，过滤无关 DOM/滚动变动并去重坐标 IPC，移除 `window.atelierDesktop!` 非空断言；④ 提取 `frontend/src/features/chat/run-stage.ts` 统一 `RunProgress` 与 `RunLiveStatus` 的阶段优先级和 `toolLabel` 本地化；⑤ 修复 `frontend/src/features/extensions/picker.tsx` 按 `activeCount` 设置 `aria-activedescendant` 并去重三条选择路径的光标恢复；⑥ 提取 `server/secret-redaction.ts` 统一 `agent.ts` 与 `harness-progress.ts` 凭据脱敏，删除零生产调用的 v1 `buildHarnessCheckpoint`/`renderHarnessCheckpoint` 死代码。无数据库迁移与外部契约破坏，回退可直接撤销本提交。
- `npm run check`、`npm run check:headers`（17 份变更/新增源文件）、`npm run build`、`npm run build:desktop` 及 `ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 全部通过（运行时 820 通过、6 跳过；前端 155 通过、1 跳过，含真实 Claude Agent SDK 0.3.332 回环测试与系统 Chromium 夹具）。
- 隔离 Wayland 真实 Electron 烟测 `node --import tsx scripts/smoke-right-tool-panels.mts`（中英文终端/Git/原生浏览器 450–1440 px、窄窗、全屏、收起恢复）与 `node --import tsx scripts/smoke-ordered-conversation.mts`（锁定 SDK、回环模型、中英文 1280/1440/1920、停止与重试、新旧对话混排）全部通过。未使用付费模型验证，未验收系统安装包，未切换日用桌面实例。
- **开发过程 review**：先通过 Codex（`gpt-6.2-sol` + `high`）在 `workspace-write` 沙箱完成 6 项小范围定向修复，再由主会话在完整环境运行 Chromium 夹具与真实 Electron 烟测，第一时间拦截了沙箱内测不到的 SSR 无桥空渲染与 `page.evaluate` `__name` 注入问题；后续委派前端浏览器改动时，在 brief 中明确提醒避免在 `page.evaluate` 内声明嵌套命名函数、且保留无桥 SSR 渲染路径。

## 2026-11-27 · 停止反馈与 SDK 重试通知（界面已验证，待重启桌面）

- 停止请求在界面立即反馈，服务端确认前不假报停止，失败后刷新快照；部分正文与已发生结果保留。「只读续接」说明会开启新一轮。重试只在运行中显示一条状态，原始通知留在执行轨迹并区分停止前后；旧对话无需迁移。[决策、证据与回退](../../../docs/decisions/2026-11-27-stop-retry-feedback.md)
- `npm run check`、`npm test`（运行时 817 通过、6 跳过；前端 146 通过、1 跳过）、`npm run build` 和 `npm run build:desktop` 通过。Linux Wayland 真实 Electron、锁定 SDK 与隔离回环模型通过中英文停止结果、停止失败注入、刷新重开、旧重试诊断和正常后续发送。复现：`node --import tsx scripts/smoke-ordered-conversation.mts`；日志、截图和外部 SDK 探针在 `.local/stop-retry-feedback/`。未使用实际模型验证或验收安装件。日用实例承载本轮运行，未切换。
- 外部直连已验证存在停止后新请求；公开 `interrupt()` 后关闭对已进入 CLI 队列的消息仍发新请求，因此未改网络路径或原生取消语义，等待外部出站闸门的兼容方案确认。
- **开发过程 review**：以回环实际收到的请求数判定重试，而非以 SDK 通知数推断；用同一 Electron 烟测覆盖失败和重开。下次把历史诊断夹具与运行状态夹具分别复位，避免测试之间继承不相关的状态。
- 单批 `gpt-6.1-terra` / `xhigh` 文件说明复核完成。按 `.local/stop-retry-feedback/headers.sha256` 核对 17 份源文件后更新 12 份说明，17 份均通过独立 `npm run check:headers -- --files …`。

## 2026-11-27 · 终止后续发的轮次间距（已验证，待重启桌面）

- 有序对话将每轮放入独立区块，原来的消息下边距不再分隔轮次；终止提示卡与下条消息因此紧贴。在有序轮次后恢复既有 24px 轮次间距，同时覆盖下一条为旧格式消息的混排，不更改运行或取消行为。回退可移除 `chat.css` 的相邻轮次规则。
- 真实样式 Chromium 夹具先复现 0px，修复后在终止、失败、中断、完成、有无正文及新旧格式混排下验证 24px。`npm run check`、`npm test`（运行时 817 通过、6 跳过；前端 146 通过、1 跳过）、`npm run build` 和 `npm run build:desktop` 通过。
- 隔离 Wayland Electron、锁定 SDK 与回环模型实际发送、终止、续发，在 1280×800、1440×900、1920×1080 中文及英文界面检查卡片到气泡约 24px；截图及结果在 `.local/ordered-spacing/`。回环模型不是实际模型，未验收安装件。当前任务由日用 Electron 承载，不能关闭父进程切换实例，待本轮结束后重启工作台加载新版。
- **开发过程 review**：先通过真实样式几何断言确定边界，再复用有序对话桌面烟测；桌面断言应容许亚像素精度，终止夹具要等模型请求实际到达，避免把启动时序当成布局问题。
- 文件说明经单批 `gpt-6.1-terra` / `xhigh` 复核，三个源码输入 SHA-256 均匹配，已集中更新对应文件头；复核结果见 `.local/ordered-spacing/headers-review.txt`。

## 2026-11-27 · 真实网关请求计时配对（已验证并切换）

- `gpt-6.2-sol` 实机探针确认 Shunt 0.64.0 的 Responses 早启流没有 `request-id`，SDK Assistant 和 OTLP 请求跨度因此缺少共同标识。运行时为受信托管连接补齐成功响应的本机标识。已有标识、外部网关和会话兼容键沿用原行为。缺少有效匹配的过去记录和非流式结果仍独立展示。[决策与回退](../../../docs/decisions/2026-11-27-sdk-resume-request-timing.md#2026-11-27--真实网关的请求配对)
- 真实模型隔离复验得到一次请求、一条含跨度及流的诊断记录，导出无原始 ID。真实 Electron 和锁定 Shunt 以无响应 ID 的回环夹具验证两个请求分别配对、诊断下载和换端口后的续接。外部网关夹具通过中英文验收。并发乱序、保留原标识、429、压缩和取消用例通过。`npm run check`、`npm test`、前端和桌面构建通过，运行时 817 项、前端 146 项通过，7 项跳过。证据在 `.local/sdk-request-timing/correlation-live.json`、`correlation-managed/` 和 `correlation-external/`。
- 旧日用窗口空闲并正常退出后沿用原 `.data` 与浏览器 profile 启动新版。Wayland 窗口已显示，网关健康正常，SQLite 完整性及项目、会话、消息、设置、附件、队列哈希一致。启动和回退路径记录在 `.local/sdk-request-timing/correlation-release`。
- **开发过程 review**。先用真实请求确定缺失发生在响应头，再把同一条件加进既有桌面烟测。复用 SDK 的精确匹配，避免用时间戳猜配，也避免为修复更换已锁定的 Shunt 二进制。单批 `gpt-6.1-terra` / `xhigh` 核对六份源码哈希，集中更新四处文件头，六份均通过 `npm run check:headers -- --files …`。复核路径记录在 `.local/sdk-request-timing/correlation-headers`。

- **真实长任务计时**。在真实 Electron、内置 Shunt 和 `gpt-6.2-sol` 中档运行隔离队列审计及修复，原始 8 项测试有 6 项失败，完成后独立复跑 15 项全过。整轮 180.823 秒；16 次请求全部配对，SDK 请求区间合计 180.387 秒，其中首内容前 151.572 秒、首内容后 28.815 秒。26 次工具的去重区间为 0.452 秒，均与请求区间重叠；两者以外合计 0.436 秒。无 SDK API 重试。首个流事件中位数 44 毫秒，首个内容事件中位数 5.015 秒、最慢 30.425 秒，二者反映不同边界。脚本与报告保存在 `.local/sdk-request-timing/long-task-benchmark.mts` 和 `.local/sdk-request-timing/long-task-cYuunF/`。

## 2026-11-27 · 托管网关续接与模型请求计时（已验证并重开桌面）

- 基线 `34f9d34`。截图对应运行累计 572 秒时，工具区间并集约 55 秒。26 个同会话托管端口变化的对照样本全部重建 SDK 上下文。现由运行时用受信内置 Shunt 的稳定身份续接，旧键通过已完成的 SDK 消息锚点和原始网关配置核验。另保留按完整地址区分外部连接和在证据不足时恢复应用历史的路径。[决策、依据和回退](../../../docs/decisions/2026-11-27-sdk-resume-request-timing.md)
- 状态栏显示整轮耗时和距最近活动的时间。执行轨迹及脱敏下载展示上次工具结束、SDK 请求起点、首流、首内容、流结束和重试等观测值。用本机回环接收 SDK 跨度，按实际请求 ID 关联，运行收尾批量保存。SDK 侧的请求等待包含网关与上游，现有 Shunt 数据无法拆出两者各自耗时。
- 真实 SDK 0.3.332 回归覆盖旧键、原会话和旧分叉、外部网关地址变化、并发子任务、重试、首流前失败、取消、认证与脱敏。`npm run check`、`npm run build`、`npm run build:desktop` 与 `ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 通过，运行时 816 项、前端 146 项通过，7 项跳过。初次全量中两项 Skill 断言失败，隔离对照、定向复跑和第二次全量均通过。日志保存在 `.local/sdk-request-timing-*.log`。
- 用 `node --import tsx scripts/smoke-sdk-request-timing.mts` 在隔离 Electron 验收中英文等待提示、计时、导出和关闭重开。设置 `ATELIER_TIMING_MANAGED_SHUNT=1` 用真实 Shunt 0.64.0 启动，确认重启换端口后 SDK ID 和合成 Read 结果仍在。本轮模型响应均为回环替身。最终报告和截图在 `.local/sdk-request-timing/bilingual-evidence/` 及 `.local/sdk-request-timing/managed-evidence/`。
- 日用实例空闲且原数据锁已释放后，沿用原数据根和 Chromium profile 启动经验证的开发构建。Wayland 窗口和托管网关健康正常，SQLite `quick_check` 返回 `ok`，4 个项目、22 个会话、179 条运行及消息、设置、附件和队列内容的前后哈希一致。部署及候选路径在 `.local/sdk-request-timing/latest-deployment`，可从同一数据根和 profile 重开上一个候选回退。
- **开发过程 review**。先用已有事件量出工具与空档，再做一次本地 SDK span 探针，避免为计时改变模型传输。把故障、并发和历史兼容的验证加进现有真实 SDK 夹具，只用桌面烟测验证用户入口、双语和真实 Shunt 生命周期。单批 `gpt-6.1-terra` / `xhigh` 说明复核按输入哈希应用，复核期间有修改的桌面烟测文件留给后续维护。
- **真实模型耗时对照**。用真实 Electron、内置 Shunt 和 `gpt-6.2-sol` 中档，从同一份旧会话快照重开对照。1 文件任务旧版 6.151 秒、新版 3.273 秒，减少 2.878 秒。3 文件任务旧版 9.458 秒、新版 5.706 秒，减少 3.752 秒。两组共减少 6.630 秒（42.5%），重复 Read 共减少 4 次，SDK 轮次从 6 降至 2，输出均正确。顺序为旧→新、新→旧。原右侧面板工单为跨模块实现与验收，历史整轮 941.64 秒，耗时不能用本次小样本直接外推。真实网关在这两条新版样本里的请求跨度和 SDK 流分别记录，未取得可靠的关联 ID。实验脚本和脱敏原始结果在 `.local/sdk-request-timing/live-ab.mts` 及 `.local/sdk-request-timing/live-ab-rXNCt0/result.json`。

## 2026-11-27 · 统一右侧工具行为（已验证）

- Git、浏览器和终端共用全屏／恢复停靠、收起按钮及分隔条。收起保留路由和实例，顶部入口或快捷导航恢复；单个标签关闭不变。三者使用 1120 px 停靠阈值、450–1440 px 范围和同一宽度偏好，停靠为会话保留 420 px。规则写入 `AGENTS.md` 和[面板接入](../../../docs/panel-development.md)，[决策及回退](../../../docs/decisions/2026-11-27-right-tool-panels.md)记录旧宽度兼容。无数据库迁移、无新 IPC。
- `npm run check`、`npm test`（运行时 807 通过、6 跳过；前端 146 通过、1 跳过）、`npm run build`、`npm run build:desktop` 通过。`node --import tsx scripts/smoke-right-tool-panels.mts` 使用生产 Electron 入口、真实 Git/PTY/WebContentsView、隔离项目和 profile，分别在中英文用鼠标验证拖动极限、全屏、收起恢复与 1000 px 窄窗；确认 Git 草稿、同一 shell 和同一原生网页实例保留。另有 Chromium 原生桥替身验证对话框遮挡和坐标同步。无模型或安装件验收。日志和截图见 `.local/right-tool-panels/`。经进程链核对，日用 Electron 是本轮执行的父进程，未关闭或切换。
- **开发过程 review**。用同一份三面板烟测比较实际拖动边界，不分别新增三套脚本。先用 Chromium 替身定位布局和焦点，再用 Electron 主进程核对原生网页 ID 和坐标；桌面语言复跑必须走 preload 的语言偏好，而不是 Web 的 localStorage。
- 单批 `gpt-6.1-terra` / `xhigh` 文件说明复核完成；21 份源码快照的 SHA-256 均匹配，集中更新 10 份职责说明，`npm run check:headers -- --files …` 通过。回执保存在 `.local/right-tool-panels/headers-review.log`。

## 2026-11-27 · 切换会话弹窗样式（已验证）

- 在 `34f9d34` 的快捷交互上复用快捷导航的弹窗宽度、幽灵按钮和主题选中色；会话行加入同款图标，保留当前会话勾选，超长标题可截断并悬停查看。只滚动结果区，标题、搜索、关闭按钮和双语键盘提示保持可见。搜索、排序、导航和存储契约不变；回退只需撤销本轮渲染器、词条和测试改动。
- `npm run check`、`npm test`（运行时 807 通过、6 跳过；前端 146 通过、1 跳过）、`npm run build` 和 `npm run build:desktop` 通过。真实 Electron 主入口与隔离 Node 运行时通过 12 项快捷键烟测：26 条会话下，在 1280×800 中文及 1920×1080 英文界面验证滚轮只移动列表、键盘选中项滚动入视野、空结果、Esc 焦点归还及 Enter 切换。复现：`ATELIER_SHORTCUT_EVIDENCE=.local/session-switcher-style node --import tsx scripts/smoke-shortcuts.mts`。无模型请求；截图和日志保存在 `.local/session-switcher-style/`。日用窗口承载本轮执行，未退出或切换。
- 文件说明通过单批 `gpt-6.1-terra` / `xhigh` 只读复核。五份输入 SHA-256 均匹配，原说明仍准确，`npm run check:headers -- --files …` 通过。
- **开发过程 review**。复用快捷键桌面烟测，在原本两会话草稿验证结束后再加入长列表，避免耦合两组测试的数据。几何断言比截图更直接证明滚动边界，首轮全量测试暴露的面板夹具缺少快捷键设置接口，补齐只读返回并保留未知请求断言。

## 2026-11-27 · 运行时 HTTP 模块拆分（已验证）

- `server/app.ts` 从恢复时的 2,650 行降到 299 行，只装配用例、显式注册领域路由及协调关停。请求边界和 SSE 位于 `server/http/`，会话、运行、队列、Git 和扩展业务归对应模块；最长 HTTP 源文件 126 行。`check:architecture` 限制入口与 HTTP 文件行数，并禁止反向导入组合入口。[决策与回退](../../../docs/decisions/2026-11-26-runtime-http-modules.md)
- `npm run check`、`npm test`（运行时 800 通过、2 跳过；前端 140 通过）、`npm run build`、`npm run build:desktop` 通过。另单独开启 RTK 补测，原跳过的固定版本 RTK 用例通过。真实 HTTP 和 SQLite 验证关停中的 SSE、待定目录选择及回执/事件的同事务回滚；真实 Wayland/Electron 窗口用系统 Git、锁定 SDK 和回环模型验证中英文 Git 自动刷新。[复现与限制](../../../docs/evidence/runtime-http-modules/2026-11-27.md)
- 保留 API 路径、权限、SDK 执行行为及原数据表，不需要迁移。回退时一并撤销组合入口、模块和仓储绑定，保留既有插话改动。未生成新安装件或切换日用实例。单批 `gpt-6.1-terra` / `xhigh` 复核 69 份源码及 SHA-256；核对并更新本次改变职责的文件头，`npm run check:headers` 通过。
- **开发过程 review**。对照恢复时的 `app.ts`，先保留路由匹配、断连和事务顺序，再用已有 Git/队列测试和两条针对性回归验证。桌面烟测应先核对当前模态状态，分开控制“打开面板、暂存、提交”三个时点。未改动的 broker fixture 首跑偶发 `BrokenPipeError`，单项与随后全量均通过，不把排查扩到无关模块。

## 2026-11-26 · 紧凑工作台布局（渲染器已验证；全量运行时与生产 main 验收受限）

- 按用户确认的设计，从 `main@28981393991d2e34edaae725e06d19123b568b61` 新建 `feat/compact-workbench-layout`。侧栏合并为 48 px 工具栏与底部图标入口，项目会话树从顶部约 96 px 开始；搜索原位展开。标题及图标标签合并进工作台顶栏，成功回执、文件行和输入区精简。保留模式/模型文字、失败重试、运行状态、工作树恢复及既有面板行为。
- 等价架构/Query/i18n/UI/四组 TypeScript 检查、前端构建和前端测试通过（125 通过、15 项需系统 Chromium 而跳过）。真实沙箱 Electron 渲染器使用隔离 HTTP/native-bridge 夹具，在中英文各 1280×800、1440×900、1920×1080 验证导航、键盘、焦点、草稿、成功文件行和失败入口，另覆盖 800 px 浏览器独占与侧栏收起。六组全部通过，消息区高度为 616/716/896 px，输入框底部随窗口为 800/900/1080 px。[命令、截图与限制](../../../docs/evidence/compact-workbench-layout/2026-11-26.md)
- 当前 `tsx` CLI 的 Unix IPC 受限，使用 `node --import tsx` 运行同一检查。完整运行时测试停在未改动的 detached-process 回收用例，窄测 10 通过、1 失败、1 取消，外部超时退出 124；当前 `/proc` 缺少每线程 `children` 信息。完整生产 main 的单实例锁也受 Unix socket 权限限制。未把渲染器替身验收记为真实模型、PTY、安装件或用户桌面切换验收。
- 回退为撤销本布局提交，无数据格式迁移。文件说明以本地验收提交 `3291ceb0ec6add28893131cdac94fccd02440ad5` 为快照，按仓库规范使用 `gpt-6.1-terra` / `xhigh` 单批复核 18 份 SHA-256，核对原文件后集中更新 3 个必要文件头。
- **开发过程 review**。截图发现遗留未分层 CSS 覆盖新网格行，将消息区压到 48 px；补几何断言先复现，再修正样式层级。布局验收先检查正文高度与输入框位置，再复用交互用例。全量测试无进展时改用有外部超时的单文件复现，明确环境限制后停止重复全量运行。

## 2026-11-26 · 会话变更记录入口（已验证）

- 将「变更记录」从工作台顶部工具栏移到会话的「执行轨迹」标签页下方，保留待审批数量、现有抽屉和键盘焦点返回。回退时把入口移回工作台工具栏。
- 定向 Chromium 回归、`npm run check`、`npm test`（913 通过、5 跳过）及前端和桌面构建通过。隔离 Electron 在 1280×800 中文界面和 1440×900 英文界面验证入口位置、回车打开、Esc 关闭和焦点返回。验收证据见 `.local/session-changes-placement/`。日用实例仍在运行 Yazi，保留当前进程。

## 2026-11-26 · 终端流控与重连对齐 VS Code（已验证）

- 暂停后等未确认输出从 384 KiB 降至 192 KiB 才恢复读取，512 KiB 硬上限继续生效。只在 ACK 序号有进展时延长停滞期限。快照恢复和实时输出用同一屏幕队列，前端确认快照后才按序收到实时帧，关闭、替换和超时释放等待。[取舍与回退](../../../docs/decisions/2026-11-26-terminal-workbench.md#2026-11-26--对齐-vs-code-的流控和快照交接)
- 定向用例先复现小 ACK 过早放行与恢复期间输出引起的断线，修复后均通过。隔离 Electron 用真实 Neovim 持续重绘并暂扣快照确认，恢复后 52 个实时帧按序确认，同一缓冲区可继续编辑。完整 12,000 行终端烟测和暂扣输出 ACK 的 20,000 行压测通过。证据见 `.local/terminal-vscode-alignment/`。日用窗口运行 Neovim，保留当前进程。
- **开发过程 review**。将高低水位和快照交接分成两个可独立复现的测试。真实桌面的重连验证同时保留帧顺序、回执和可编辑缓冲区证据，继续复用已有大输出烟测。

## 2026-11-26 · 终端输出积压和输入确认（已验证）

- 在真实 manager 延迟 ACK 复现旧版 `TERMINAL_SLOW_CONSUMER`。接近未确认输出上限时暂停读取 PTY，待 ACK 腾出空间后继续读取。彻底停滞超时仍会断开，替换或关闭连接会释放等待。Chromium 在 xterm 阻塞时复现输入回执已经抵达却误报未确认，改为即时处理回执、连续输出合并解析。[取舍及回退](../../../docs/decisions/2026-11-26-terminal-workbench.md#输出积压与输入回执)
- 真实 Electron 和 PTY 暂扣输出 ACK，待积压停在约 384 KiB 时验证仍能收到输入回执。恢复 ACK 后同一连接显示 20,000 行的最后标记且可以继续输入。完整终端烟测通过，包括 12,000 行、重载后同一 shell、隐藏输出、Ctrl+C、中英文和进程退出。另断开真实 Neovim 的连接，验证未保存缓冲区恢复并可继续编辑。记录和截图见 `.local/terminal-flow/`。
- **开发过程 review**。用受控 ACK 复现真正的慢连接，用独立输入回执测试区分传输和渲染。真实桌面保留输出累计字节及屏幕末尾两种证据，定位到逐小帧解析造成的滞后。

## 2026-11-26 · 终端连接提醒（已验证）

- 将断连、重连和未确认输入放入标题栏提醒图标，移除常驻的屏幕恢复说明。确认输入提醒可清除本次记录。回退可恢复原终端视口内的状态行。
- 隔离 Electron 使用真实终端，在输入确认处注入慢连接断开。旧版将视口从 760 px 挤到约 692 px。新版打开弹层、重连和关闭提醒后视口始终为 760 px，确认了同一终端重连后可继续输入。中英文均通过，涵盖提示收起、键盘打开和重连前确认输入提醒。截图和复现脚本见 `.local/terminal-notices/`。
- `npm run check`、`npm test`、`npm run build` 和 `npm run build:desktop` 通过。完整终端烟测仍卡在大输出末尾标记的等待。日用实例有活动 shell，保持原窗口。
- **开发过程 review**。旧的 12,000 行输出场景在超时截图中已经显示结束标记，未出现慢连接提示。此次分别验证注入断连和真实大输出，避免将烟测等待期限误判为连接故障。

## 2026-11-26 · 终端配色与 Neovim 可读性（已验证）

- 参考本机 Oh-DSH 终端插件的亮暗 ANSI 色板及实时主题更新，并启用 xterm 4.5 的最低文字对比度。工作台切换主题时原终端会话继续运行。[决策与回退](../../../docs/decisions/2026-11-26-terminal-workbench.md#终端颜色与对比度)
- Chromium 回归在修复前识别出浅色真彩文字未调整，修复后核对亮暗 ANSI 色板及原连接保留。隔离 Electron 中使用真实 zsh 和 Neovim 0.12.6，透明背景浅色文字在白底上的实测对比度由 1.53:1 提升至 5.18:1，深色背景保留原 RGB。截图、探针及日志见 `.local/terminal-colors/`。日用实例仍在运行 Neovim，待退出后重开加载构建。
- **开发过程 review**。复用终端浏览器夹具设置可控的 RGB 前景，再用真实 Neovim 核对同样的颜色及屏幕。后续颜色问题先分别验证 ANSI 和 RGB，避免仅靠截图推断是哪一层配色。

## 2026-11-26 · 精简终端界面（验证中）

- 参考用户提供的 DSH 截图及本机 `oh-dsh/plugins/panel-controls/src/terminal/TerminalPanel.tsx`：去掉路径和正常连接状态行，将终端关闭放入各自标签并直接结束该终端；面板按钮换成关闭分栏图标，仍只收起视图，不结束终端。断线和失败时保留错误及重连入口。回退为恢复原面板工具栏和终止确认对话框。
- 隔离 Electron 真实 PTY 定向流程通过：新建多个终端、关闭非选中标签而保留当前终端、关闭当前标签并核对 shell 退出、收起重开、窗口尺寸调整、中英文、自然退出和应用退出。为避开上一轮已记录的 12,000 行输出超时，该定向流程跳过大输出步骤；截图及结果见 `.local/terminal-ui-refinement/`。日用桌面还有三个活动 shell，未切换实例。

## 2026-11-26 · 终端布局调整（验证中）

- 参考本机 DSH 将终端标签和操作放在同一行，并让终端表面和文字使用项目主题变量。此前错误引用不存在的 `--card` 等变量，面板透明；窗口缩窄进入全屏时底层会话和导航透出，表现为终端文字叠在其他内容上。
- 在隔离 Wayland/Electron 窗口使用真实 PTY 重现透明背景：修复前计算样式为 `rgba(0, 0, 0, 0)`，修复后为当前主题色。实际改变窗口尺寸，验证右侧停靠、窄窗全屏、放宽后停靠、关闭后面板及终端 DOM 移除；截图保存在 `.local/terminal-layout/wayland-green/`。扩展终端烟测以检查不透明背景、真实窗口尺寸变化和关闭。
- `npm run check`、`npm test`、`npm run build`、`npm run build:desktop` 通过（运行时 772 通过、5 跳过，前端 139 通过）。完整终端烟测已通过新增布局检查，之后在 12,000 行输出后等待结束标记超时；延长等待也未通过，隔离数据保留于 `/tmp/atelier-terminal-desktop-lEOv7j`。日用桌面仍有活动 zsh，未切换以免终止用户终端。回退可恢复 `frontend/src/features/terminal/` 的面板结构与样式。

## 2026-11-26 · 合并 main 至人工终端分支

- 合入 main 的 RTK、Skill 继承、有序对话和子代理插话，保留终端服务、PTY 与 RTK 发行清单及双方执行日志。通过 `npm run check`、`npm test`、`npm run build` 和 `npm run build:desktop`。运行时 776 项通过、1 项跳过，前端 139 项通过。完整日志保存在 `.local/terminal-main-merge/`。
- 本次验证覆盖源码检查和测试，合并后的实际安装件及真实 Electron 终端仍待验收，沿用人工终端条目记录的状态。

## 2026-11-26 · 人工终端与面板合同（开发分支；桌面/发行验收阻塞）

- 按用户最新要求从 `main@f48da53d` 新建 `feat/terminal-workbench`。保留最新 Git 文件阅读/引用、任务进度、原生 Bash 控制与同目录会话功能，加入静态 Panel SDK/registry/Host 和会话人工终端。[接入文档](../../../docs/panel-development.md) · [技术决策](../../../docs/decisions/2026-11-26-terminal-workbench.md)
- Terminal 由 Node sidecar 持有真实 PTY，界面用 xterm，HTTP 管生命周期与单次票据，WS 管交互与屏幕恢复。显示/隐藏与资源生命周期分别管理，未确认输入不重放。独立目录保留阻止回收但允许 Git 写操作；不会占用 Agent 执行槽。
- 39 项 Terminal 聚焦测试通过；main 兼容回归 18 通过、1 项既有跳过；前端纯状态/路由/目标 7 项通过。类型、架构/Query/i18n/UI 子项和等价前端/桌面构建通过。`npm run check/build` 原入口因 tsx Unix IPC 权限失败，完整 `npm test` 超时；真实 Electron 因 Unix socket 权限中止，完整 Linux 安装件缺构建工具。尚未切换用户运行实例。[分层验证与复跑说明](../../../docs/evidence/terminal-workbench/2026-11-26-implementation.md)
- 独立审查促成 in_place 目录身份、面板历史返回、关闭/失联客户端回收、慢创建附着时机、烟测新建入口与 shutdown 失败传播修正。源码与固定依赖进入工作分支，真实浏览器/Electron/安装件结果不以替身代替。
- **开发过程 review（本轮实施）**。先冻结共享协议再并行负责后端、界面和发行，集中审查跨层接口。复用了现有 Git/SDK 测试和 p1 烟测。Unix IPC 与缺显示环境应在首次预检明确，后续不重复尝试依赖相同能力的本地入口；需要窗口的验收集中到已配置的 CI/桌面。完整桌面验收与文件说明收尾状态在证据中持续更新。
- 文件说明使用 `gpt-6.1-terra` / `xhigh` 对本批 63 份输入按 SHA-256 只读核对，集中应用 9 份必要建议；未将桌面/安装态验收记为完成。
## 2026-11-26 · 子代理插话与 RTK 合并验证

- 将子代理插话提交与 RTK、会话轨迹合并，Bash 回执继续确认 RTK 实际命令，主会话工具边界按子代理归属判定。隔离工作树通过 `npm run check`、`npm test`、`npm run build` 和 `npm run build:desktop`，真实 RTK 与锁定 SDK 用例包含在全量测试中。
- 首次测试因隔离工作树缺少 RTK 归档缓存失败，指定已校验归档重跑通过。日志保留在隔离工作树的 `.local/merge-verification/`。合并后的桌面安装件尚未单独验收，运行中的桌面继续使用此前版本。

## 2026-11-26 · RTK Bash 命令覆盖（已验收并切换）

- 使用随包 RTK OSS 1.2.1 的匹配规则，覆盖文件、搜索、构建、测试、包管理、Git 和基础设施的支持形式。可逐段改写复合命令，保留显式机器可读格式、管道、重定向、远程默认分支和比较日志的原始输出。SDK 继续对原命令及实际命令做权限检查。开关、回执和回退入口沿用现有界面。[取舍与回退](../../../docs/decisions/2026-11-26-rtk-command-coverage.md)
- 基线 `f48da53`，候选包含同工作区的对话内运行提示，精确输入哈希见 `.local/rtk-command-coverage/evidence/final/candidate-inputs.json`。通过 `npm run check`、`npm test`、`npm run build` 与 `npm run build:desktop`。运行时 734 项、前端 131 项通过，1 项既有 WebFetch 用例跳过。真实 SDK、RTK 和回环模型核对项目覆盖、两侧审批、取消和后台、npm 参数及 XDG、截图场景的远程 HEAD 和分叉合并提交、机器可读输出及重开后轨迹。
- Arch 安装件 SHA-256 为 `5549a7e514606b9880c2437c211e1a8a00b3be4528847650515d81cfa48adc96`。以 pacman 安装到独立系统根，使用隔离 Electron 在中英文核对 `ls -la && rg …`、实际命令、按项目开关和重开持久化，通过通用 `npm run smoke:linux`。10 次冷启动和附加场景均正常退出，实际模型调用为零。证据在 `.local/rtk-command-coverage/evidence/final/`。
- 等旧桌面空闲后正常关闭，保存可恢复的 SQLite 副本并以该安装件、原数据目录和浏览器 profile 启动。3 个项目、17 个会话、142 次运行、292 条消息、2,559 个工具记录、15 项设置与待处理消息表逐项相同。窗口已显示，运行时、本机网关返回 200，随包 RTK 二进制与启动器校验通过。切换记录见 `.local/rtk-command-coverage/evidence/final/desktop-switch.json`。
- 11 份候选文件的文件头经单批只读核对，集中更新 4 份说明。变更只涉及文件头，`npm run check:headers` 通过。
- **开发过程 review**。把截图的两类 Git 查询与非 Git 命令放进同一回环运行，可以同时验证覆盖、回执和必要信息。下次直接使用锁定 CLI 提供的插件文件接口，并在首次候选冻结前加入机器格式、项目祖先规则和带全局参数的 RTK 管理命令用例。

## 2026-11-26 · 对话内运行提示（已验收并切换）

- 基线 `f48da53`，候选源码哈希见 `.local/inline-run-status/source.sha256`。运行阶段与耗时放在当前轮次末尾，随对话滚动。最近活动时间可悬停查看。停止入口沿用输入区控制。回退时恢复运行提示在输入区上方的挂载点和样式。
- `npm run check`、`npm test`、`npm run build` 与 `npm run build:desktop` 通过。工作区 RTK 接口及断言同步后，最终运行时 730 项通过、5 项跳过，前端 131 项通过。隔离 Electron 用锁定 SDK 和回环模型验证等待、工具执行、耗时、流式输出及结束。1280×800、1440×900 和 1920×1080 下核对行宽和位置，并验证减少动效。Chromium 快照覆盖中英文等待文案。截图与日志在 `.local/inline-run-status/electron/`。
- 沿用日用数据目录和浏览器 profile 打开新版。窗口已显示，运行时和托管网关均返回 200，交付的前端入口与构建一致。项目、会话、运行、消息、工具和设置记录指纹一致，数据库版本为 10。证据见 `.local/inline-run-status/live-result.json`。文件说明经单批只读复核，`npm run check:headers` 通过。
- 主题微调。状态文字与图标跟随当前主题的主色，耗时使用辅助文字色。原安装版运行时搭配新界面，在隔离 Electron 用回环模型当场切换六个主题校验颜色，最小文字对比度为 4.87:1。通过 `npm run check`、`npm test`、`npm run build`、`npm run build:desktop` 和文件头检查。日用窗口已沿用原数据与 profile 启动，记录指纹一致。截图、日志与回退所需的旧界面保存在 `.local/inline-run-status-theme/`。
- **开发过程 review**。复用有序对话的 Chromium 测试与 Electron 回环夹具。用一个可释放的模型响应检查等待行，避免依赖模型响应时长。分隔线在屏幕缩放下会按物理像素取整，后续验收检查可见性和最大宽度。主题调整复用原安装版运行时，在同一个等待状态内依次切换六个主题。

## 2026-11-26 · 按真实执行顺序展示会话（已验收并切换）

- 从新运行开始按原生 SDK 的观察顺序保存和显示用户消息、模型正文、工具、审批及错误。并行结果回写原位置，旧轮次仍可读正文、展开明细、查看执行轨迹。输入区显示实际执行阶段与耗时。[技术决策与回退](../../../docs/decisions/2026-11-26-ordered-conversation.md)
- 基线 `f48da53`。以 `.local/ordered-conversation/headers-input.json` 的候选文件哈希核对含现有 Skill 继承的实物版本。通过 `npm run check`、`npm test`、`npm run build` 与 `npm run build:desktop`。运行时 690 项通过、1 项既有跳过，前端 129 项通过。
- 锁定 SDK 与回环模型验证并行倒序完成、重试、错误、逐次审批、插话、取消、启动前中断、507 个正文片段及运行时重开。隔离 Linux Electron 核对中英文、1280/1440/1920 宽度、断线补齐、长等待计时、键盘焦点与同会话的新旧记录。日志和截图见 `.local/ordered-conversation/exact-candidate/`。
- 沿用原数据目录和浏览器 profile 打开新版。项目、会话、运行、消息、工具和设置指纹一致，运行时及本机网关响应均为 200。 首次启动进程退出后，使用独立用户服务重新打开并在命令结束后复核窗口仍在运行。数据副本、上一版构建和切换记录保存在 `.local/ordered-conversation/rollout-nbimxaqm/`。
- 文件说明按候选哈希核对，20 份源码通过独立文件头检查。
- **开发过程 review**。SDK 回环用例先验证内容片段和调用身份，Electron 复用相同顺序断言。事件流断线用一次可控的连接失败和原生重试验证，省去重复尝试断掉已有连接。下一轮在窗口验收前冻结运行时源码和构建，避免重开时混用两个版本。

## 2026-11-26 · 内置 RTK Hook（Linux 安装态专项与通用发行验收通过）

- Linux x64 随包提供 RTK OSS 1.2.1。本机信任的主会话对四条固定 Git 命令默认包装；项目 Hooks 可跟随全局、启用或停用，轨迹展示收到回执的原命令和实际命令。关闭项目 Hook 或使用 `rtk bypass` 可恢复完整输出。子代理与受控执行保留原行为。[权限预检、取舍与回退](../../../docs/decisions/2026-11-26-builtin-rtk-hook.md#2026-11-26--采用-cli-插件的原生权限预检)
- 基线 `f48da53`，保留同工作区中已有 Skill 继承与对话改动。已验收输入的逐文件哈希存于 `.local/rtk-delivery/source-sha256.txt`。`npm run check`、`npm run build`、`npm run build:desktop`、`npm test` 通过。启用真实 RTK 夹具时运行时 734 项通过、1 项既有 WebFetch 跳过，前端 131 项通过。SDK 0.3.332 配回环模型核对两侧规则、半途切换开关、后台/取消、非零返回、单次派发及重开后轨迹。真实 RTK 的四种形式与原生 Git、`bypass` 的输出对照见 `.local/rtk-delivery/git-command-matrix.json`。
- 最终 Arch 包的 SHA-256 为 `0574c8668fddcb6e674ff7283e5944b411ce5cd5a967a7fd4f3ea92079df93bd`。使用 pacman 安装至独立系统根，隔离 Electron 的两个项目、中英双语、1280/1440/1920 宽度、开关及重启均通过，真实 SDK 与真实 RTK 走回环模型，实际模型调用为零。证据在 `.local/rtk-delivery/electron-final/`。当前活动桌面未切换。
- 通用 `npm run smoke:linux` 使用同一 pacman 安装件在 Xvfb 的隔离命名空间跑至 `complete`，退出码 0，安装目录指纹一致。自动化对话的 17 条工具明细按持久化位置展示，3 条有自动批准标记，全程无手动审批卡。浏览器下载、离线重开、PDF 预览和托管网关重开全部通过。10 次冷启动、3 次附加启动均正常退出，残留进程 0，最慢冷启动 1,789 ms，最慢退出 116 ms，实际模型调用 0。完整报告及驱动哈希在 `.local/rtk-delivery/release-smoke-passed.json`、`release-smoke-rerun-3.log` 和 `release-smoke-driver.sha256`。本次只调整 smoke，复用上一轮已构建并验证的包。
- 文件头按候选源码哈希单批使用 `gpt-6.1-terra`、`xhigh` 复核，37 份源码哈希匹配，集中更新 2 处职责说明，`check:headers` 通过。证据在 `.local/rtk-delivery/headers-review.log` 和 `header-only-updates.sha256`。
- **开发过程 review**。最初查验只覆盖 SDK `Query` 接口；CLI 插件的 `$.tool.check` 能解决原命令预检。以后遇到类似权限语义时先查锁定 CLI 的插件类型，并用带执行次数的无害包装夹具验证。安装态覆盖保留用户 XDG Git 配置与绕过命令的原始输出。通用 smoke 核对 pacman 本地元数据，按结构化回执 ID 关联模型步骤，并在相邻场景间显式确认浏览器与首次引导的状态。下一轮用持久记录校验有序工具明细，移除批准方式与展示方式之间的过时假设。

## 2026-11-26 · 本机 Skill 继承与会话限制（隔离验证通过）

- 分支 `feat/skill-inheritance`，基线 `f48da53`。保留项目扩展管理，新增「本机继承」和「本会话 Skills」。全局默认关闭；打开后只加载逐项启用的本机 Skill。设置由运行时保存到 SQLite，不改本机目录或安装配置；已开始的运行保留原清单，受影响的待处理消息保留并提示重发。[决策与回退](../../../docs/decisions/2026-11-25-skill-inheritance.md)
- `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`（运行时 686 通过、1 项既有跳过；前端 126 通过）、`npm run build`、`npm run build:desktop` 通过。追加的真实 SDK 子代理断言通过定向测试和类型检查。锁定 SDK 配回环模型验证同名来源、默认停用、显式调用、仅手动、全局与项目和会话范围、排队期间撤销及子代理请求不含停用内容；未调用实际模型。
- 隔离 Electron 使用真实 API、临时数据根和独立 `userData` 验证中文 1440×900 全局操作、英文 1280×800 会话草稿、重载保留和 Esc 焦点恢复。截图及日志在 `.local/skill-inheritance/`。文件说明按已验证源码哈希单批核对，`npm run check:headers -- --files …` 检查 31 份源码通过。正式窗口仍承载当前会话，本轮不在运行中关闭它；候选版未切换、未提交。
- **开发过程 review**。复用同一回环模型按阶段断言候选清单、工具回执和队列阻止；桌面夹具使用同一窗口切换语言，不重复装数据。下一轮先跑定向回归，再顺序运行构建和浏览器测试，避免 Markdown 包构建清空中间产物时影响测试。

## 2026-11-25 · Claude CLI Bash 控制与同目录并行（已验证并启动）

- 本机信任使用 Claude SDK 的原生时限、后台任务和逐命令停止。 `Ctrl+Enter` 在 Bash 仍运行时投递同会话消息。运行时按 SDK 会话、任务和执行者确认终态和日志，重启后保留缺少回执的记录。不同会话可以共享一个规范化工作目录，同时保留 Git 租约和受控写入队列。[技术决策](../../../docs/decisions/2026-11-25-claude-bash-and-parallel-sessions.md)
- 基线 `ad016d6` 和 `.local/claude-cli-bash/final-inputs.sha256`。 `npm run check`、`npm test`、`npm run build`、`npm run build:desktop` 通过。运行时 682 项通过、1 项跳过，前端 121 项通过。用锁定 SDK 和回环模型验证超时、非零退出、停止、重复调用标识和插话，并从隔离 Electron 核对中英文、日志与切换。
- 新版沿用原数据目录及浏览器 profile 启动。3 个项目、12 个会话、114 次运行和 7 项设置的记录指纹一致。桌面证据、数据库可恢复副本和上一版构建保存在 `.local/claude-cli-bash/`。
- **开发过程 review**。独立评审发现任务通知可能先于工具回执，补了执行者归属和早到回执的回归。对消息检查点使用可释放的回环响应来验证实际投递，减少对 SDK 进程调度顺序的假设。

## 2026-11-25 · 紧凑会话列表与模型菜单（已验证并启动）

- 侧栏减轻底色和选中态，标题、时间和菜单同排，突出活动圆点。输入区模型弹层用两行显示模型及推理深度的当前值，共用选项列表、手填和刷新逻辑。可独立回退侧栏样式或选择器的菜单样式。
- 类型检查、全量测试（运行时 679 通过、1 跳过，前端 120 通过）、前端与桌面构建通过。侧栏夹具核对长标题、时间同排、状态点与菜单。中英文 Electron 核对经典及深色主题、两行菜单、固定档位、手填和焦点恢复。Git 多提交的独立模型回归通过。证据在 `.local/sidebar-compact-rows/` 和 `.local/compact-model-menu/`。新版沿用原数据和 profile 启动，项目、会话、运行和设置指纹一致。
- **开发过程 review**。用同一窗口核对侧栏与模型弹层在浅色和深色主题的效果。模型用例在工作区 Markdown 构建结束后复跑，避开并行重建期间的临时依赖缺失。

## 2026-11-25 · 侧栏会话状态（已验证并切换）

- 侧栏会话行分别展示标题、运行或未查看状态和时间。待审批保留到运行状态变化。后台成功或异常标记保持到打开对应会话。标记归当前窗口，重启清除。[状态决策与回退](../../../docs/decisions/2026-11-25-sidebar-session-status.md)
- 基线 `ad016d6` 加 `.local/sidebar-session-status/verified-inputs.sha256`。类型检查、前端和桌面构建、全量测试通过（运行时 679 通过、1 跳过，前端 120 通过）。Chromium 夹具覆盖待审批、失败、重复事件、长标题与窄侧栏。隔离 Electron 使用真实 SDK、本地模型替身和实际 SSE 核对中英文的后台完成和点击已读。新版沿用原数据目录及 profile，项目、会话、运行和设置指纹一致。
- **开发过程 review**。沿用侧栏夹具验证标签与状态边界，用实际 SDK 只复核跨会话事件。后续侧栏状态改动可复用同一组事件和窄栏断言。
- 会话列表恢复标题和时间上下排列，左侧只显示状态圆点，状态文字用于悬停和辅助技术。复用侧栏夹具验证无常驻文字、圆点位置和点击已读。类型检查、全量测试（运行时 679 通过、1 跳过，前端 120 通过）、构建及中英文 Electron 验证通过。新版沿用原数据目录与 profile 启动，数据指纹一致。证据在 `.local/sidebar-status-dots/`。
- 圆点统一改为实心，执行中用蓝色、已完成用绿色。侧栏夹具核对五种状态的填充与颜色，中英文 Electron 验证实际事件流的颜色变化和点击已读。类型检查、全量测试（运行时 679 通过、1 跳过，前端 120 通过）及构建通过。证据在 `.local/sidebar-solid-dots/`，随工具区新版切换。

## 2026-11-25 · 对话运行历史摘要（已验证并启动）

- 已结束的运行在正文上方显示一行状态和耗时。一次展开即可查看工具、任务清单和子任务。进行中的审批、工具状态和失败恢复仍从各自原有位置操作。回退聊天展示、对应词条和验收入口即可恢复旧版。
- 基线 `87fcc31` 加 `.local/chat-run-summary/verified-inputs.sha256`。类型检查、全量测试（运行时 679 通过、1 跳过，前端 120 通过）以及前端和桌面构建通过。隔离 Electron 用合成历史核对中英文折叠和展开，用真实 SDK 加本地模型替身验证在途工具详情、完成后保留展开、完整日志和键盘焦点。新版使用原数据目录及 profile 启动，项目、会话、运行和设置指纹一致。
- **开发过程 review**。复用消息、子任务和工具详情测试分别覆盖布局、SSE 更新与真实 SDK 回执。以后修改消息折叠入口时，同时检查历史子任务的展开路径。
- 运行中的工具区使用与正文对齐的单行状态，集中显示当前动作、结束进度和失败数，最近活动时间通过悬停查看。工具行用细分隔线，保留分页、键盘展开及审批入口。类型检查、全量测试（运行时 679 通过、1 跳过，前端 120 通过）及构建通过。隔离 Electron 用 18 次合成调用核对中英文和窄窗，用真实 SDK 加本地模型替身复核完整日志和焦点。证据在 `.local/chat-live-tool-style/`，可单独回退运行中的展示、词条和验收入口。
- 运行任务结束后正常退出旧窗口，沿用原数据目录、profile 和网关启动新版。项目、会话、运行和设置指纹一致。
- 输入区任务卡与输入框同宽，保留完整边框并留出 8px 间距。完成项使用勾选图标，进行中使用浅色底。复用消息操作回归验证宽度、间距、圆角和键盘操作。类型检查、全量测试（运行时 679 通过、1 跳过，前端 120 通过）、构建和中英文隔离 Electron 验证通过。新版已切换，原数据指纹一致。证据在 `.local/composer-task-card/`，可单独回退本次任务卡样式。
- 展开后的工具区使用「工具调用」，显示调用总数、失败数和已显示数量。分页按钮显示下一批实际新增数量，跳过已经显示的在途调用。复用消息操作回归核对键盘分页和末页，隔离 Electron 用 71 项合成调用核对中英文、11 项失败和在途条目。类型检查、全量测试（运行时 679 通过、1 跳过，前端 120 通过）和构建通过。新版已切换，原数据指纹一致。证据在 `.local/chat-tool-call-pagination/`，回退涉及工具区、文案和测试。

## 2026-11-25 · 工作台顶部状态与设置入口（已验证并切换）

- 顶部用绿色和琥珀色圆点显示事件流连接状态，悬停或聚焦显示当前状态。设置统一从侧栏底部进入，对应验收脚本沿用同一入口。回退涉及工具栏、样式、文案和脚本。
- 类型检查、全量测试、前端与桌面构建通过。运行时 679 项通过、1 项跳过，前端 120 项通过。隔离 Electron 验证中英文提示、键盘聚焦、模拟断线后重连、紧凑布局和侧栏设置入口。新版沿用原数据目录及 profile，项目、会话、运行与设置指纹一致。证据在 `.local/workspace-status-dot/`。
- **开发过程 review**。复用对话桌面夹具，通过拦截与恢复同一个事件流请求验证两种状态，无需启动额外的后端替身。

## 2026-11-25 · 消息页脚精简（已验证并启动）

- 用户消息页脚只保留时间和操作。输入区仍提供运行模式选择，历史权限模式可在执行轨迹查阅。恢复页脚上的模式标签即可回退显示改动。
- 通过类型检查、前端与桌面构建、定向 Chromium 回归。用隔离 Electron 和合成历史验证中英文的本机信任标签、运行模式选择与执行轨迹。沿用原数据目录启动新版，项目、会话、运行和设置指纹一致。结果及截图在 `.local/chat-footer-mode/`。
- 全量测试复跑通过，运行时 679 项通过、1 项跳过，前端 120 项通过。首轮技能代理用例遇到 `Broken pipe`，复跑未复现。复用已有消息操作回归和独立 Electron 夹具，分别覆盖通用运行模式和截图中的本机信任场景。
- 用户消息时间与气泡右缘对齐，操作显示在时间左侧。复用消息操作用例和 Electron 夹具核对中英文、悬停与聚焦。类型检查、全量测试（运行时 679 通过、1 跳过，前端 120 通过）和前端及桌面构建均通过。已切换桌面并核对原数据指纹，证据在 `.local/chat-time-alignment/`。恢复原页脚排列规则即可回退。

## 2026-11-25 · 对话消息布局（已验证并切换）

- 用户消息用随内容收窄的右对齐气泡，文件和附件引用留在气泡内。助手正文沿阅读列展示，执行明细可展开。短时间、运行模式和原有操作收在消息底部，时间提示提供完整日期。沿用[前端设计规范](../../../frontend/DESIGN.md)的主题与阅读宽度。回退本次 renderer 组件和样式即可恢复版式。
- 基线 `1c84f48` 加验收源码哈希。通过 `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`、`npm run build` 和 `npm run build:desktop`。运行时 679 项通过、1 项既有跳过，前端 120 项通过。隔离 Electron 使用合成对话，核对中文 1440×900、英文 1280×800 和 540px 窄视口的气泡、换行、键盘操作与执行明细。截图、原始日志和输入哈希在 `.local/chat-message-layout/`。
- 待活动任务结束后正常退出旧窗口，用原数据目录和 Chromium profile 打开新版。3 个项目、19 个会话、130 条运行和 7 条设置记录指纹一致。运行时及本机网关响应均为 200。
- **开发过程 review**。把气泡尺寸和页脚位置断言加进已有的 Chromium 消息操作测试。执行明细展开时页面会随内容变化滚动，复用键盘操作核对折叠及消息按钮获得焦点。下次用同一对话夹具同时验证截图和键盘布局。

## 2026-11-25 · 输入区统一提交与模型设置（已验证）

- 空闲与运行中统一使用发送箭头，去除底部常驻按键和权限提示。辅助技术仍可读取快捷键与权限说明，现有队列区域继续显示入队项目。会话内用同一入口显示模型与推理深度，展开后保留默认模型、手填 ID、固定档位和目录刷新。[决策与回退](../../../docs/decisions/2026-11-25-composer-compact-controls.md)
- `npm run check`、`npm run build`、`npm run build:desktop` 和全量测试通过（运行时 679 通过、1 跳过，前端 120 通过）。隔离 Electron 用替身的目录和运行快照验收中英文组合控件、关闭焦点和提交后队列显示。定向 Chromium 覆盖 IME、现有入队语义、固定档位、手动选择及 Git 多提交中的独立设置。证据在 `.local/composer-compact-controls/`。文件说明独立检查通过 6 份源码。
- 首次构建时用户桌面仍在运行任务。任务结束后随「对话消息布局」的桌面构建一起切换。
- **开发过程 review**。复用现有的消息操作和模型夹具，在同一个测试内验证视觉入口改造与原运行语义。桌面场景仅替换运行快照及目录，避免为纯 UI 调整消耗真实推理调用。

## 2026-11-25 · Git 阅读选区引用与复制路径（已验证并切换）

- 选区通过工具栏动作或 `Alt+Shift+Q` 加入当前同项目会话草稿，卡片显示文件和行号，发送文本带代码原文与版本来源。路径图标复制仓库相对路径。重用草稿保存、去重、删除和长度限额。[决策与回退](../../../docs/decisions/2026-11-25-git-reader-code-quotes.md)
- `npm run check`、`npm run build`、`npm run build:desktop`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 通过（运行时 679 通过、1 跳过，前端 120 通过）。隔离 Electron 用高亮的真实 Git 文件验证反向跨行选择、终止换行的行号、保留输入、重复引用、草稿重载和无自动发送，并用 Clipboard 写入探针核对复制值。中英文入口均核对，证据在 `.local/git-code-quotes/`。独立 `check:headers` 通过 11 份文件。
- 旧窗口正常退出后沿用原数据目录和配置启动新版。项目、会话、运行与设置内容指纹一致，运行时及本机网关均返回 200。
- **开发过程 review**。用现有草稿写入回执同时核对原文、行号和保存，为单次验收提供来源证据。使用真实高亮的反向选区覆盖跨节点与尾部换行，避免单独测试视觉行号就误判正确。

## 2026-11-25 · Git 文件阅读标签（已验证并启动新版）

- 文件变动与历史详情的全文入口统一打开 Git 阅读标签。按工作树、路径、版本和历史提交去重，保留每个阅读位置及返回时的差异选择。编辑区使用行号、语法高亮和独立横纵滚动。窄侧栏用带提示的图标收紧固定入口，打开文件菜单可选被滚出视野的标签。[决策与回退](../../../docs/decisions/2026-11-25-git-file-reader-tabs.md)
- `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`（运行时 678 通过、1 跳过，前端 120 通过）、`npm run build`、`npm run build:desktop` 均通过。隔离 Electron 用真实 Git 比较三个版本，验证去重、原差异筛选、滚动恢复、键盘切换和关闭，以及中文 1440×900 和英文 1280×800 的全窗口/侧栏切换。复制通过 Clipboard 写入探针核对原文。截图、脚本和结果在 `.local/git-file-reader-tabs/`。
- 切换时旧实例已退出，未持有运行时锁。沿用原数据目录和浏览器配置启动，旧项目、会话、运行和设置的内容指纹一致，运行时及本机网关返回 200。11 份文件通过独立文件说明检查。
- **开发过程 review**。从同一 Electron 夹具先抓到弹窗回归，再验证打开、返回和版本隔离。英文窄侧栏截图暴露了活动标签被裁切，补测标签元素和容器边界后再生成交付截图。

## 2026-11-25 · Git 差异阅读与文件定位（已验证并切换）

- 提交详情每个折叠文件只保留标题行，用图标控制展开、折叠和对比模式。单个下拉替代横向文件条，窄侧栏查看提交时差异占满阅读区，关闭返回提交列表。文件变动和提交详情均支持行内与左右对比，前后版本的上下文与变更对齐。[决策与回退](../../../docs/decisions/2026-11-25-git-diff-review-controls.md)
- 文件图标按历史提交、索引或工作区预览完整文本。历史删除项读取第一父提交。文件夹图标通过可信桌面桥定位当前检出的文件。`npm run check`、`npm run build`、`npm run build:desktop` 和全量测试复跑通过（运行时 678 通过、1 跳过，前端 120 通过）。首次最终全量运行里，独立执行器夹具父进程先写出 `ready`，后代尚未写 `ticks` 就被取消。定向复跑和全量复跑通过。
- 隔离 Electron 用真实 Git 验证中文 1440×900 下的 41 文件滚动、键盘展开、批量折叠、左右行对齐、历史快照、删除前内容和窄侧栏返回。英文 1280×800 验证索引、工作区全文和左右对比。系统定位使用真实 IPC 与配对运行时，Electron shell 调用由探针核对路径。脚本、截图和原始结果在 `.local/git-review-controls/`。
- 旧窗口正常退出并释放数据锁后，以相同数据目录、浏览器配置及本机网关开启新版。SQLite 完整性检查通过，3 个项目、19 个会话、124 个运行及 7 项设置内容指纹一致，运行时和网关健康端点返回 200。单批文件说明核对后，19 份源文件通过独立 `check:headers`。
- **开发过程 review**。从截图中的重复入口直接建立 41 文件夹具，一次覆盖大列表、左右对齐和读取真实版本。通过区分提交、暂存和工作区的文本，验证完整预览不会拿错版本。下次先用同一份夹具比较宽、窄布局，省去为滚动单独准备数据。

## 2026-11-25 · Git 按层丢弃与双层差异（已验证并切换）

- 分支 `feat/git-layer-aware-review`，基线 `3b7f45d`。文件行的丢弃动作带变更层。未暂存从索引恢复，已暂存明确同时恢复索引和工作区，未跟踪只删除路径。确认框列出路径与影响。通过现有项目工作树 API 复核目标并串行写入。同文件两层差异可直接切换和同时查看。[决策与回退](../../../docs/decisions/2026-11-25-git-layer-aware-review.md)
- `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`（运行时 677 通过、1 跳过，前端 119 通过）、`npm run build` 和 `npm run build:desktop` 通过。真实临时 Git 仓库覆盖保留索引、重命名、首次提交前新增、过期目标和未跟踪替代文件保护。隔离 Electron 在 1280×800 验证中文双层差异、Esc 后焦点和保留暂存，在 1440×900 验证英文过期提示和恢复 HEAD。复跑入口和截图保存在 `.local/git-layer-aware-review/`。
- 旧窗口正常退出后运行时释放数据锁。沿用原数据根、浏览器配置和本机 Shunt 重开，窗口已映射，运行时与网关 HTTP 均为 200。SQLite `quick_check` 通过，版本及 3 个项目、19 个会话、124 条运行和 7 条设置记录数量一致。文件说明单批只读核对后，独立 `check:headers` 检查 13 份源码通过。
- **开发过程 review**。用分层内容和索引条目校验操作效果，避免将 Git 刷新的索引 stat 缓存当成暂存内容变化。复用现有 Electron 启动夹具，将多语言、撤销确认和文件状态变化合在同一条用户流程。

## 2026-11-25 · Git 分支侧栏重构、提交历史无限滚动与多维检索（已验证并切换）

- 重构 Git 工作区「分支与提交」面板：移除手动加载更多按钮，改用 `IntersectionObserver` 哨兵实现触底自动无限加载（240px 预取、状态锁、轻量骨架屏、初始提交分割线及重试条）；重构左侧栏信息层级，新增固定 HEAD 状态卡片、可折叠分组、选中深绿指示条、微型检出 HEAD 标签、紧凑 Worktree 路径胶囊（悬浮 Tooltip 绝对路径）及远端前缀弱化；增加左侧纯前端 0 延迟即时模糊搜索与右侧防抖（250ms）关键词（信息/Hash/作者）、作者与时间范围多维检索。[技术决策](../../../docs/decisions/2026-11-25-git-history-and-branch-workbench.md)
- 按照 React 最佳实践与单一职责拆分前端组件目录 `frontend/src/features/git/git-history/`（提取 `useGitCommitFilters` 自定义 Hook 隔离状态与防抖副作用，抽取 `GitHeadCard`、`GitBranchGroup`、`GitBranchItem`、`GitCommitRow`、`GitCommitSkeleton` 等纯展示子组件并使用 `React.memo` 优化长列表重绘开销）；后端提取 `queryGitLogCommits` 与时间区间校验，消除重复参数与容错逻辑。
- 自动化检查与测试全量通过：`npm run check` 零错误通过；`npm run check:headers` 对新增及修改源码通过；`node --import tsx --test tests/git-workbench.test.ts`（11 项通过）；`npm run test:frontend`（119 项通过）；`npm test` 全量通过。
- 桌面端平滑切换：通过 `npm run build && npm run build:desktop` 完成生产构建，在当前运行的 Linux x64 Electron 实例中热切换生效，无缝保留既有数据目录与配置。现场核对分支过滤、提交多维筛选、短 Hash 复制及触底无限加载均正常运转。
- **开发过程 review**。针对搜索检索体验，将「前端 0 延迟防御性即时过滤」与「后端 `git log` 全量深层检索」结合，彻底消除了输入过程中的不匹配提交闪烁与网络滞后竞态。拆分出单一职责的 memo 纯组件后，无限滚动滚动过程中仅受影响行重新渲染，性能显著提升。下一轮若有类似列表检索需求，优先沿用本套组合式 Hook 与防御过滤模式。

## 2026-11-25 · 凭据测试样例可预览（隔离验证通过）

- 用临时 Git 仓库复现截图中五个测试文件的凭据命中。测试改用运行时构造的合成样例，以及用于回环认证的明确占位符。生产快照复验五个文件均可进入模型候选和提交预览，独立凭据阳性对照仍同时被这两道检查拦截。复跑 `node --import tsx .local/ai-commit-test-fixtures/verify.mts`，输出为同目录 `red.log` 和 `snapshot.log`。[决策与回退](../../../docs/decisions/2026-11-24-ai-multi-commit.md#2026-11-25--凭据回归测试样例)
- 定向运行五个测试文件，85 项通过。隔离副本按顺序通过 `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`、`npm run build` 和 `npm run build:desktop`。运行时 660 项通过、1 项既有 WebFetch 跳过，Chromium 119 项通过。五份源文件说明检查通过。测试、检查、构建输出和候选 SHA-256 均在 `.local/ai-commit-test-fixtures/`。
- 隔离 Electron 打开修正前的计划，预留受限分类触发预览过期提示，然后重新读取工作树。旧分组和标题保留，五个修正的文件回到待分配并批量进入逐组预览，阳性对照继续保留不提交。Electron 验收没有推理请求。原仓库 HEAD、暂存区和运行窗口保留。[桌面状态](../../../docs/evidence/ai-multi-commit/test-fixtures/resolved-zh-1280.png) · [机器结果](../../../docs/evidence/ai-multi-commit/test-fixtures/electron-result.json)
- **开发过程 review**。直接让生产快照读取测试源码，定位到合成输入写法，避免扩大到测试目录白名单。桌面夹具首跑发现批量分组会切换筛选，随后增加等待工作树读取完成的步骤。下次修改凭据回归样例时先跑源码可提交性检查，再用同一临时仓库验证阳性对照和最终预览。

## 2026-11-25 · AI 提交的对话修改（隔离验证通过）

- 首轮可补充分组要求，随原分析会话恢复。审查时继续用当前模型按要求改标题、挪动或合并整批变更，界面列出实际改动并支持撤销。摘要可直接确认，详情可核对逐组差异。摘要确认保留验证结果及操作 ID，执行响应丢失后可重取回执。[技术决策和回退](../../../docs/decisions/2026-11-24-ai-multi-commit.md#2026-11-25--对话修改提交草稿)
- Chromium 首跑缺少可输入的首轮要求，修复后通过首轮请求、对话修改、撤销及原续跑保留编辑断言。API 以临时 Git 和回环替身验证过期快照、伪造受限 ID 及带凭据的补充要求均被拒绝，披露负载也不含受限路径、差异、手写正文或历史里的合成凭据。证据在 `.local/ai-commit-conversation/{red,chromium,test}.log`。
- 验收基线 `3db4a86` 加 `.local/ai-commit-conversation/sources-final.sha256`。隔离副本按顺序通过 `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`、`npm run build` 和 `npm run build:desktop`。运行时 660 项通过、1 项既有 WebFetch 跳过，前端 119 项通过。原始输出在 `.local/ai-commit-conversation/{check,test,build,build-desktop}.log`。
- 隔离 Electron 以真实 Git 验证一条请求归并 25 个 OpenWiki 变更并改名、失败后保留要求和手写正文、根据上文追问、逐组预览和撤销。首次提交响应交付中断的实验复现了旧代码的快照过期提示。修复后使用同一操作 ID 和摘要重试，回执恢复，临时仓库最终只增加 3 条确认过的提交。确认前 HEAD 和暂存区字节一致。中英文复验包含英文深色的修改失败提示。网关捕获 2 次规划与 4 次修改请求，均为回环替身。真实模型的分组质量尚未验证。复跑 `node --import tsx .local/ai-commit-conversation/electron-smoke.mts <隔离源码副本> .local/ai-commit-conversation`。[对话摘要](../../../docs/evidence/ai-multi-commit/conversation/conversation-zh-1280.png) · [逐组预览](../../../docs/evidence/ai-multi-commit/conversation/preview-zh-1440.png) · [英文错误状态](../../../docs/evidence/ai-multi-commit/conversation/conversation-en-error-1440.png) · [机器结果](../../../docs/evidence/ai-multi-commit/conversation/electron-result.json)
- 单批只读核对 18 个文件，更新 10 个有效说明，独立 `check:headers` 通过。原仓库 HEAD、暂存区和运行窗口保留，全部验证提交创建于临时仓库。源码与候选逐项比较及文件说明证据位于 `.local/ai-commit-conversation/`。
- **开发过程 review**。把修改失败、只改指定分组、手写正文保全和撤销合并到同一个 Electron 验收夹具。通过 renderer 丢弃首个成功响应复现提交回执丢失，保留真实 Git 执行与权限复核。下一轮新增确认入口时直接复用这个夹具同时覆盖执行已完成和客户端未知状态。

## 2026-11-25 · 手动提交与待决定项批量分配（隔离验证通过）

- Git 文件工具栏新增手动入口，读取冻结快照后打开一组空白草稿，用户可选已暂存、未暂存及未跟踪改动。需要决定视图支持勾选单块、同类里的整个文件、整类或全部待决定项，选定目标后显式应用。每次只修改草稿分组及保留列表，提交继续使用既有逐组预览、确认和恢复接口。包含受限项的选择可整批保留。回退范围为本次工具栏、编辑器及词条。
- Chromium 先复现同文件多块缺少批量选择，修复后在 246 项夹具核对按文件归组、批量保留、受限目标禁用、冲突门禁和手动入口零推理。定向类型、i18n、UI 检查通过。原始输出为 `.local/ai-multi-commit-bulk/{red,chromium}.log`。
- 隔离副本按顺序运行 `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`、`npm run build`、`npm run build:desktop`，全部通过。运行时 658 通过，1 个既有 WebFetch 跳过，前端 119 通过。原始输出为同目录 `{check,test,build,build-desktop}.log`。
- 隔离 Electron 使用真实 Git 和回环模型替身，在 AI 计划中一次分配同文件三个变更块；从独立手动入口选中三个块并确认创建一条本地提交，另一文件仍在暂存区，两项未跟踪改动保留。前后推理计数证明手动流程为零，真实模型调用为零。中英文渲染视口为 1280×800 和 1440×900，核对 Esc 后焦点返回手动入口。复跑入口 `node --import tsx .local/ai-multi-commit-bulk/electron-smoke.mts <隔离源码副本> .local/ai-multi-commit-bulk`。[批量分配](../../../docs/evidence/ai-multi-commit/bulk-manual/bulk-assignment-zh-1280.png) · [手动预览](../../../docs/evidence/ai-multi-commit/bulk-manual/manual-preview-zh-1440.png) · [机器结果](../../../docs/evidence/ai-multi-commit/bulk-manual/electron-result.json)。
- 原仓库 HEAD 和暂存区指纹一致。用户运行窗口保留本轮前状态。单批核对 7 个验收源码输入，集中更新 5 份文件说明，独立 `check:headers` 通过。工作区与构建副本的行为源码一致，证据为 `.local/ai-multi-commit-bulk/headers/` 和 `headers.log`。
- **开发过程 review**。同一临时仓库先验证 AI 返回未分组块，再用独立手动入口直接选取并提交这些块，以一条 Git 结果同时覆盖批量分配和暂存保全。Chromium 测试负责混合限制和冲突状态，桌面复验聚焦真实入口与 Git 状态。

## 2026-11-25 · 多提交模型与推理偏好（隔离验证通过）

- 根据用户反馈直接复用聊天输入框的 `ModelPicker`，多提交独立保存上次模型和推理等级于 SQLite settings；跟随默认时保留默认语义，不修改聊天模型。选择中的等级以 `output_config.effort` 发到各批及最终整理；固定路由以网关配置为准，实际上游采纳情况未用真实模型验证。[决策](../../../docs/decisions/2026-11-24-ai-multi-commit.md)
- `npm run check`、`npm test`（运行时 658 通过、1 跳过；前端 119 通过）和 `npm run build` 通过。隔离 SQLite 测试覆盖重启后恢复与损坏数据回退；隔离 Git API 测试覆盖默认不继承聊天等级、Shunt/Magpie 请求及改变等级拒绝旧会话续跑。Chromium 测试覆盖保存失败重试、模型切换、固定等级、延迟保存顺序和页面重开。
- 隔离 Electron 关闭并重启，确认 `fixture-picked` / `high` 恢复、三次回环模型请求均带 `output_config.effort=high`，并完成两条测试提交；中文与重启英文截图：[中文](../../../docs/evidence/ai-multi-commit/persisted-model-zh-1280.png)、[重启后英文](../../../docs/evidence/ai-multi-commit/persisted-model-restarted-en.png)。未调用真实模型。用户运行窗口未切换，避免丢失当前状态。
- 文件说明维护批次 `multi-commit-preferences / 未提交工作区` 待补总结：`.local/multi-commit-preferences-headers.sha256` 和 brief 已保存；后台 `codex exec` 被自动审批以可能向外部模型发送私有仓库内容为由拒绝，未绕过。`npm run check:headers` 已通过。
- 开发过程 review：直接复用已有模型选择器和 SQLite 独立设置，避免复制能力映射；先用受控延迟验证快速切换，再以独立 Electron 重启验证持久化，减少对真实数据和付费模型的依赖。

## 2026-11-24 · 重新打开后的多提交复测

- 用户要求重新打开并测试；启动前未发现运行中的 Atelier 桌面或运行时，使用 `npm run desktop` 沿用原有数据目录启动。实际窗口显示原工作区及会话列表；只读 SQLite `quick_check=ok`，2 个项目和 14 个会话可读取。
- 使用 `node .local/multi-commit-electron-smoke.mjs`、隔离项目/profile 和本地回环模型，验证缺失编号提示、继续分析、完整围栏输出、核对和创建两条测试提交，中英文主流程通过。截图和合成夹具在 `/tmp/atelier-multi-electron-B5B9PZ/`；未调用真实模型，也未向外部发送真实工作区差异，因此不能证明 GPT-6-Luna 原问题已解决。

## 2026-11-24 · 多提交响应兼容与诊断（隔离验证通过）

- 完整单层 JSON 围栏及 `stop_sequence` 完成响应经过现有 schema、凭据和 ID 完整性校验后可用；不修复截断或忽略任何变更。网关消息、JSON、分组字段、长度和 ID 错误分别提示；零批失败后可更换模型重新开始。保留已有成功批次与手动编辑，不自动付费重试。[决策](../../../docs/decisions/2026-11-24-ai-multi-commit.md)
- `npm run check` 通过；`npm test` 运行时 651 通过、1 跳过，前端 119 通过。后续新增 390 合成项的七批覆盖测试以及 `tsc --noEmit` 通过；`npm run build` 通过。隔离 Electron 使用回环网关先返回缺失 ID，然后返回完整 JSON 围栏，验证明确错误、继续分析、逐组预览及创建两条测试提交；截图：[缺失编号提示](../../../docs/evidence/ai-multi-commit/planner-missing-id-1280.png)。未调用真实 GPT-6-Luna；此次实际失败的具体错误仍未知。
- 开发过程 review：先按失败类别复用本地回环测试，再用隔离 Electron 验证真正入口；旧桌面夹具因界面流程更新而首次失效，改用当前先规划后审查的入口后通过。大批次自动拆分需单独设计检查点和费用上限，不在无真实原因证据时引入。

## 2026-11-24 · AI 多提交实时进度（隔离验证通过）

- 分析中显示当前批次、进度条、已验证变更块和建议组数量。全部批次完成后单独显示最终整理。统计来自运行时冻结分析会话，专用只读查询不重读 Git 或增加推理请求，关闭或分析结束即停止查询。[决策与回退](../../../docs/decisions/2026-11-24-ai-multi-commit.md)
- Chromium 先复现只有等待提示，修复后在回执仍挂起时读到批次进度，并验证快照版本、分析编号、查询关闭与推理次数。运行时定向测试 71 项通过，覆盖跨项目、工作树、版本和不同分析编号的进度隔离。原始证据为 `.local/ai-multi-commit-progress/{workflow-red,workflow,server-targeted}.log`。
- 在隔离源码副本依次运行 `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`、`npm run build` 和 `npm run build:desktop`。运行时 646 通过、1 个既有 WebFetch 用例跳过，前端 119 通过。全量复验曾有既有 Skill 代理请求体测试偶发 `Broken pipe`，同源码复跑通过。原始输出为同目录 `{check,test,build,build-desktop}.log`、`test-broken-pipe.log`。
- Linux x64 Electron 45.4.1、独立 profile 和回环模型夹具在请求挂起时验证第 1 / 3 批、第 2 / 3 批和已分析 64 / 129 项，随后观察全部 129 项完成并进入整理，整理失败后仍能续跑、保留编辑和本地创建 3 条提交。检查英文单批进度及中文 1280×800、英文 1440×900 视口。真实模型调用为 0。复跑入口 `node --import tsx .local/ai-multi-commit-progress/electron-smoke.mts <隔离源码副本> .local/ai-multi-commit-progress`。[实时批次](../../../docs/evidence/ai-multi-commit/progress/analyzing-zh-1280.png) · [最终整理](../../../docs/evidence/ai-multi-commit/progress/organizing-zh-1280.png) · [机器结果](../../../docs/evidence/ai-multi-commit/progress/electron-result.json)。
- 验收源码与工作区 12 份源码哈希一致，原仓库 HEAD 及暂存区指纹一致。用户运行窗口未切换。单批复核并应用 9 份文件说明，独立 `check:headers` 覆盖 12 份源码并通过。证据为 `.local/ai-multi-commit-progress/{source-receipt.json,headers.log,headers/}`。
- **开发过程 review**。复用 131 项 Electron 夹具，在第二批和最终整理的实际请求挂起时读取进度，避免使用计时推测。发现实时计数和上一版计划的待分析数字会同时出现，调整为分析期间显示进度、返回后恢复原编辑视图，并增加可见性断言。

## 2026-11-24 · AI 多提交审查与凭据误判（隔离验证通过）

- 点击「AI 提交」先读取本地快照，展示变更块总数、可规划数量和本次模型选择。明确开始后才请求模型。审查优先显示提交组和组内变更，未分析、模型未分组和受限项各有状态。续跑绑定快照、模型和语言，断线可只读查询，过期可保留草稿后重新开始。点击预览直接定位到首组差异。
- 区分源码引用、调用、明确占位符和疑似凭据。命中时显示格式和路径或行位置，相关单元及依赖不发给模型。新增行与路径命中阻止本流程提交，删除与既有上下文命中可按本地预览确认。预览与执行重新校验冻结单元和实际提交差异。保留受保护路径、二进制仅发送元数据、冲突索引和跨层依赖限制。[技术决策与回退](../../../docs/decisions/2026-11-24-ai-multi-commit.md)
- 合成差异复现旧判断。普通引用、两种函数调用、`test-token`、可能凭据字面值和 PEM 标记均判为不可发送，删除与上下文也判为不可发送。本机原始记录 `.local/ai-multi-commit-review/baseline-privacy.log`。
- 实施前，合成凭据回归因普通引用误判和含空格字面值漏判失败，Chromium 回归因初始状态缺失失败，见 `privacy-red.log`、`workflow-red.log`。定向修复后，真实 Git 与回环网关共 15 项通过，Chromium 审查流程通过。凭据场景覆盖删除和上下文仅供本地审查、隔离同文件块、暂存依赖、二进制只传元数据以及预览和执行双侧拒绝伪造选择。浏览器覆盖 245 个单元只留下 5 项决定、失联只读查询、最终整理失败及过期后保留编辑。证据位于同一目录的 `privacy-api.log`、`workflow-chromium.log`。
- 基线 `0d3b184` 加工作区源码校验值。最终在隔离源码副本依次运行 `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`、`npm run build`、`npm run build:desktop`，均通过。运行时 646 通过、1 个既有 WebFetch 用例跳过，前端 119 通过。完整输出为 `.local/ai-multi-commit-review/{check,test,build,build-desktop}.log`，源码副本位置见 `candidate-path.txt`。较早的定向运行把网关探活误计成推理，改按 `POST /v1/messages` 核对；失败输出保存在 `server-targeted.log`。
- Linux x64 Electron 45.4.1 使用独立 Git 仓库、运行时数据根、profile 和回环网关。131 个变更块中 129 个可规划。第二个分析批次和最终整理各注入一次 HTTP 503，分别只重试失败的批次及整理请求。保留标题、正文、手动分组和明确保留项。首轮确认前 HEAD 与暂存区逐字节一致，确认后生成 3 条提交，留下 2 个明确保留的文件。检查中文 1280×800、1440×900 与英文深色 1920×1080 渲染视口，实际原生内容窗口 2560×1440，并核对预览首组差异可见及 Esc 焦点恢复。[机器结果](../../../docs/evidence/ai-multi-commit/planning-review/electron-result.json) · [选择模型](../../../docs/evidence/ai-multi-commit/planning-review/setup-zh-1280.png) · [最终整理失败](../../../docs/evidence/ai-multi-commit/planning-review/partial-zh-1280.png) · [逐组预览](../../../docs/evidence/ai-multi-commit/planning-review/preview-zh-1440.png) · [英文审查](../../../docs/evidence/ai-multi-commit/planning-review/review-en-dark-1920.png)。
- Electron 复跑入口为 `node --import tsx .local/ai-multi-commit-review/electron-smoke.mts <隔离源码副本> .local/ai-multi-commit-review`，原始输出 `electron.log`。首轮平铺窗口未保持预设几何，随后按实际原生内容边界设渲染视口，断言截图尺寸。旧输出保存在 `electron-native-first.log`、`electron-viewport-first.log` 和 `electron-before-preview-scroll.log`。真实模型分组质量、本机截图中其余凭据提示以及安装件均未在本轮验证。
- 用户窗口保留运行，真实仓库 HEAD 和暂存区指纹一致，164 个任务外原有改动路径的内容一致，未暂存、提交或推送任务改动。当前会话无 OpenWiki MCP，本次取舍和验证已记录在源码决策与执行日志。文件说明单批按 16 个输入的哈希核对，应用 4 份说明，独立 `check:headers` 通过。输入、应用记录和工作区对照见 `.local/ai-multi-commit-review/headers/` 和 `worktree-preservation.json`。
- **开发过程 review**。合并真实 Git 和回环网关验证，让披露、预览及执行共用同一组凭据与跨层变更。桌面先按实际内容尺寸校验，再断言第一组差异进入可视区域。后续在第一次桌面复验就把视口、截图尺寸和差异可见性三项纳入同一断言。

## 2026-11-24 · 多提交问题分类（隔离验证通过）

- 多提交弹窗扩展为桌面大尺寸，默认按原因分开列出待处理项，支持查看全部、已保留及逐类批量保留，保留逐项撤回和提交前预览。大量项目默认收合；有冲突时即使保留也提示先解决冲突。沿用服务端安全检查。
- `npm run check`、`npm test`（运行时 643 通过、1 跳过，前端 119 通过）和 `npm run build` 通过；调整模型设置区高度后 `check:ui`、构建与隔离 Electron 验收通过。浏览器替身覆盖 240 个已分组项与凭据、冲突、可提交的完整文件和普通待分配项，检查分类、批量保留、逐项恢复与冲突门禁。隔离 Electron 使用本地网关及合成文件验证分类和两次提交，截图：[问题分类](../../../docs/evidence/ai-multi-commit/issue-groups-1280.png)。未操作用户窗口或真实模型。
- 开发过程 review：复用现有大批量浏览器和隔离桌面夹具；桌面截图暴露设置区占高问题，缩小后复测，后续提前在 1280×800 核对可见区域。

## 2026-11-24 · 多提交待分配提示（隔离验证通过）

- 在长变更列表提供“只看待分配”筛选，底部显示不可预览或提交的原因、数量和定位入口；受保护且已保留的项不计入待分配。过期计划会禁用预览并提示重新打开。筛选不修改用户计划。
- `npm run check` 与 `npm test`（运行时 643 通过、1 跳过；前端 119 通过）在最后调整中英文数量文案及补充排除项测试之前通过；随后受影响浏览器测试、前端类型检查、`check:i18n` 和 `npm run build` 通过。隔离 Electron 用本地模型替身验证两个待分配项的底部提示、筛选和提交主流程，截图：[待分配提示](../../../docs/evidence/ai-multi-commit/unassigned-reasons-1280.png)。未读取用户正在编辑的计划或关闭其窗口。
- 开发过程 review：优先复用已有多提交浏览器及 Electron 夹具；列表筛选与底栏提示复用同一归属判定，避免两套计数发生偏差。

## 2026-11-24 · 多提交分析超时与续跑（隔离验证通过）

- 分析按批次独立限时；成功批次的分组保留在绑定项目、工作树、快照、模型和披露策略的短期内存会话中。失败后可继续剩余批次，最终整理失败时可保留批次分组。超过分组上限时明确提示并保留未分配项。运行时重启或会话过期后需重新分析。[决策](../../../docs/decisions/2026-11-24-ai-multi-commit.md)
- 独立审查发现连续断线后的重复分析、追加分组超限、全局整理遗漏曾分析但未分配单元的问题，已分别修复；`frontend/src/features/git/git-multi-commit-model-picker.test.ts` 使用本地替身验证编辑保留、续跑及连续断线恢复。`tests/git-commit-analysis-sessions.test.ts` 与 `tests/git-commit-planner.test.ts` 覆盖逐批时限、恢复、会话隔离及敏感内容；`tests/git-multi-commit-api.test.ts` 使用隔离真实 Git 仓库验证接口。未调用真实模型。
- 项目 `npm run check`、`npm test`（运行时 641 通过、1 跳过；前端 119 通过）在最后一轮界面审查修复前通过；最终修复后受影响前端测试、前端类型检查及 `npm run build` 通过。隔离 Electron 的原有主流程验收通过，覆盖两次提交、双语和 1280×800/1440×900；本次恢复交互由隔离 Chromium 替身测试，未在 Electron 中实测超时。
- 后续审查补充凭据切换与容量边界：会话使用进程密钥 HMAC 绑定实际认证令牌，凭据变化时拒绝复用；容量耗尽时保留未过期的未完成会话并拒绝新会话。`node --import tsx --test tests/git-commit-analysis-sessions.test.ts tests/git-commit-planner.test.ts` 共 59 项通过；修改后 `npm run check`、`npm test`（运行时 643 通过、1 跳过；前端 119 通过）与 `npm run build` 通过。旧 API 可省略分析 ID，断线后无法凭 ID 找回；当前界面已在请求前生成 ID。
- 开发过程 review：复用真实 Git API 和 Electron 夹具，使用独立审查针对续跑编辑合并及连续断线发现边界问题；后续应尽早把批次失败和界面编辑合并到同一端到端夹具。

## 2026-11-24 · 多提交分析模型选择（已验证并切换）

- 多提交弹窗先读取本地工作树快照，用户选择工作台默认、目录模型或手动输入模型 ID 后才发起 AI 分析；该选择仅影响本次弹窗。请求按所选模型分流至已配置的 Shunt 或 Magpie，服务端返回本次尝试的模型 ID，不改变聊天草稿或全局配置。处理中隐藏旧超时提示，覆盖率文案区分已完成项与全体元数据项。[决策](../../../docs/decisions/2026-11-24-ai-multi-commit.md)
- 用户反馈 373 个变更单元仅完成 64 项后超时：源码固定每批最多 64 项并顺序分析，整个多批流程共用 120 秒上限；64 是完成批次累计，不能仅凭截图断言是哪次请求慢。本次未调整限时或声称换模型一定能避免超时。
- `npm run check` 通过；`npm test` 运行时 630 通过、1 跳过，前端 119 通过；`npm run build` 通过。`tests/git-multi-commit-api.test.ts` 用双本地网关验证默认/所选模型、Shunt/Magpie 切换及不修改配置；`git-multi-commit-model-picker.test.ts` 覆盖选择前无推理、超时重试提示和草稿保留。真实 Electron 隔离测试验证选择前无模型请求、指定模型实际到达回环网关、默认模型回退及两条提交，检查中文/英文和深浅主题。[模型选择截图](../../../docs/evidence/ai-multi-commit/model-picker-20261124.png)；脚本 `.local/multi-commit-electron-smoke.mjs`。未调用真实付费模型。
- 已检查旧窗口没有已分组的计划和活动会话任务，正常切换新版；数据库仍为 v10、`quick_check=ok`，2 个项目及 14 个会话可读取。未触碰用户工作区暂存或提交。
- 文件说明维护批次 `multi-commit-model-selection / 0d3b184 + 未提交工作区` 已完成；7 个输入文件的哈希均匹配，已核对并应用其中 4 个文件的说明建议，`npm run check:headers` 通过。输入校验值、brief 和建议保存在 `.local/model-selection-20261124.*`。本功能尚未提交。
- 开发过程 review：复用多提交的隔离 Electron 验收脚本及本地双网关，避免重复对实际模型发请求；先直接读取批处理与时限代码，再解释截图，不将超时误判为某个来源故障。

## 2026-11-24 · AI 多提交规划（已验证并切换）

- 将单条暂存提交扩展为扫描已暂存、未暂存和未跟踪改动，生成可编辑的有序提交分组，核对逐组差异后确认；支持可安全拆分的文本块、明确排除及同文件两层依赖。高置信凭据变更不会发给模型或自动提交。签名、游离 HEAD、分离索引和无法安全处理的文件有明确限制。[决策与回退](../../../docs/decisions/2026-11-24-ai-multi-commit.md)
- 服务端冻结工作树/索引/HEAD，使用临时索引构造提交链，持久化 SQLite 操作和独立索引日志，按预期旧值推进分支。真实 Git 测试覆盖已暂存与工作区内容不同、重复确认、强制中断后恢复和两阶段安全放弃。独立审查发现 JSON 凭据过滤及 journal/SQLite 双写间中断两项问题，修复后分别由 `tests/git-commit-plan-privacy.test.ts`、`tests/git-multi-commit-api.test.ts` 和 `tests/git-commit-plan-recovery.test.ts` 回归。
- 数据库新增 v10 迁移，以隔离 SQLite 测试覆盖旧四态 v9、新式 v9、WAL、记录/rowid 保留和故障回滚；迁入测试覆盖日志/备份校验。自动权限审查最初拒绝复制真实数据库；随后用户明确授权将 `.data/atelier.sqlite` 一致性备份至 `.local/atelier-v9-backup-20261124/atelier.sqlite` 并重启。备份 `quick_check=ok`、版本 9；升级后版本 10、`quick_check=ok`，2 个项目、14 个会话、250 条消息和 122 次运行数量保持一致。
- `npm run check` 通过；`npm test` 运行时 621 通过、1 跳过，前端 118 通过；`npm run build` 和 `npm run build:desktop` 通过。Electron 隔离测试使用真实桌面、临时 Git 仓库及本地模型替身：自动生成两组、编辑第一条、预览并创建两条提交；再检查英文深色界面。未调用真实付费模型。截图：[中文 1280×800](../../../docs/evidence/ai-multi-commit/zh-light-1280.png)、[中文 1440×900](../../../docs/evidence/ai-multi-commit/zh-light-1440.png)、[英文深色 1440×900](../../../docs/evidence/ai-multi-commit/en-dark-1440.png)。测试脚本保存在 `.local/multi-commit-electron-smoke.mjs`。
- 已启动新版用户实例，真实窗口显示原有项目和会话；升级前数据库备份保留在上述私有路径。真实用户工作区未进行 AI 模型调用、暂存或提交。
- 文件说明维护批次 `ai-multi-commit / 0d3b184 + 未提交工作区` 已完成；20 个输入文件的校验值均匹配，只读整理建议对其中 6 个文件做说明更新，已核对并应用。`npm run check:headers` 通过。输入校验值、brief 与建议保存在 `.local/multi-commit-20261124.*`；尚无本功能验收提交，不将基线提交冒充本次提交。
- 开发过程 review：用相同的真实 Git 恢复夹具覆盖执行、崩溃和 HTTP 入口，避免只看模拟结果；复用隔离 Electron 的双语截图。之后先确认实际数据库版本再定迁移版本，避免运行中的旧版 v9 与开发中调整约束产生冲突；继续顺序运行共享构建目录的检查。

## 2026-11-24 · Git 面板页面滚动排查

- 使用隔离数据根启动本地服务和 Vite，在 2000×1125 视口打开本项目 Git 面板（129 条文件变动）。浏览器测得文档 `scrollHeight=6373`、视口 `clientHeight=1126`，`.git-list` 本身仍按预期可滚动。
- 129 个列表项里的 `.sr-only` 元素使用绝对定位，原定位参照为 `body`。为 `.git-list` 增加 `position: relative` 后复测：文档高度和视口均为 1126，尝试滚动外层时 `scrollY=0`；文件列表内容高度 6259、可视高度 980，可滚动至底部。`npm run check:ui` 通过；验证使用隔离数据根的 Vite 页面，未在 Electron 窗口验证。

## 2026-11-23 · 会话工具证据恢复

- 用户反馈后续细化剧情时重复抓取网页。排查真实本地 transcript：旧轮央视 WebFetch 已有剧情，新 SDK 上下文的检查点只有工具 ID 和搜索来源，没有已抓取网页与结果的关联。
- 将 SDK 兼容指纹改为版本化的执行范围身份，同模式且兼容时继续使用原生 transcript；停止、异常和旧指纹仍走保守恢复。重建检查点区分搜索发现与成功抓取，并在允许时提供旧回执读取入口。[设计与回退](../../../docs/decisions/2026-11-23-session-evidence-recovery.md)
- `tests/session-evidence-resume.test.ts` 通过真实 SDK 0.3.326 与本地回环模型验证：首轮原生 Read 取得随机事实，删除源文件并重启后切换 effort，下一轮实际请求仍含同一工具结果；自动审批切回逐次审批后写入被拒绝。`tests/session-forks.test.ts` 核对分支截点与续接；`tests/session-checkpoint.test.ts` 覆盖抓取索引、失败、截断、预算和权限隔离。所有模型响应均为本地替身，未验证真实模型自主选择，也未进行真实 WebFetch 网络回环。
- 最终 `npm test`：运行时 303 通过、1 跳过，前端 112 通过；`npm run check` 与 `npm run build` 通过。曾并行启动 build 与 check，Markdown 包生成目录发生竞争而导致类型检查失败，顺序重跑通过。经用户明确授权后正常关闭旧窗口并打开新版；确认窗口已映射、运行时和网关监听原数据目录，本机 SQLite 中原项目、会话及消息仍可读取。未实测桌面界面中的会话交互。
- 开发过程 review：先比对真实历史和 SDK 文档确定缺失位置，用 SDK 回环直接检查第二轮 messages，避免仅按模型回答判断。下次顺序执行共享生成目录的构建和检查；停止后跨轮网页回查及真实桌面体验仍需独立实测。

## 2026-11-20 · 阶段 0 / 规划与开发规则

- 判定点①选择直接生成。个人已有产品，已有原生 Electron、独立运行时与 Web 入口的实测和权衡，用户已确认 Linux 先交付、其他平台各自验收。无商业化信号。新建 `build-atelier-desktop` 包。
- 本轮基线 `1639970`。历史 release 文档与 `.local` 里的测试记录供追溯。P1–P9 均为待实施，后续从 P1 的安装态样包开始。
- 仓库开发指导位于 `CLAUDE.md` 和 `.claude/skills/atelier-electron/SKILL.md`。验证和评审结果在本节追加。

## Review 处置

本轮 `20261119T165520Z-j95yqR`。strategy 和 plan-eng 两镜均以独立上下文按 Sonnet / medium 只读复核三件套，2026-11-20 收齐两份结构化意见。用户选定仅会话内复核，外部复核记作 `runner=none reason_code=user-waived-external`。

| 来源 | 问题 | 处置与证据 |
|---|---|---|
| strategy | P1 的规则与 Skill 应先实际就位 | 采纳。`CLAUDE.md`、`.claude/skills/atelier-electron/SKILL.md` 和 `.claude/agents/atelier-desktop-reviewer.md` 已落地。Skill 结构校验通过。以新的临时配置目录启动 SDK，仅做本地发现，`supportedCommands()` 和 `supportedAgents()` 找到二者，模型请求数为 0。 |
| strategy | 成功升级后新产生的数据如何回退 | 采纳。[设计决策 4](design.md)规定保全新版副本、列出新增记录和导出，用户确认后旧版打开升级前数据。P7 使用新增成果的场景验收。 |
| plan-eng | 各控制入口要核对调用者身份 | 采纳。[设计决策 3](design.md)定义 renderer、API、私有 sidecar 信道的不同信任依据。[P2](roadmap.md)增加未授权客户端和过期连接验收。 |
| plan-eng | 人工接管时在途动作可能无法确认 | 采纳。[设计决策 3](design.md)补充交接中、执行代次撤销、结果待确认和重建目标的恢复流程，P4 注入迟到动作。 |
| plan-eng | 性能和恢复基线应形成发布门槛 | 采纳。[P1 与 P2](roadmap.md)分别冻结安装件预算和恢复时限，由 P7 在相同条件下复测。 |

## 阶段 0 验证

- Electron Skill 来源选择已查阅社区候选和锁定源码。`mindrally/skills` 的 `electron-development` 在目录查询时约 1,493 次安装，仓库约 310 stars。核对版本 `7682ca77710e0971eab4e0ae5dddfa281aea0ba5` 后，采用以 Electron 官方文档为源的项目专用指导，覆盖原生视图、接管和发行验收。
- `quick_validate.py .claude/skills/atelier-electron` 输出 `Skill is valid!`。默认 Python 缺 `yaml`，最终使用带有 PyYAML 的解释器完成校验。SDK 隔离发现输出 `skill=true, reviewer=true, modelRequests=0`。此证据覆盖配置加载；行为效果在 P1 按真实变更复核。
- 判定点②：两镜五项已逐条处置，近期阶段均回指设计，正式文档未引用历史存档。直接生成路径无备忘对账事项。P1 至 P9 为待实施。


## 2026-11-20 · P1 / 可运行的 Linux 发行样包 · 已验证

- Arch/Omarchy x86_64 包 `dist/linux/atelier-0.2.0-1-x86_64.pkg.tar.zst`，SHA-256 `94fea6119c96535163ad86143aecb7a4cd7fd1c19a8784b1b83e5e9bd76f5d40`。另附便携归档、资源清单、许可证清单和 `SHA256SUMS`。取舍见[发行决策](../../../docs/decisions/2026-11-20-linux-release.md)。本机样包包含 7 项待补上游许可文本，正式对外分发在 P7 核对。
- 使用安装包解出的启动器在独立 PID、网络、挂载、XDG 和显示环境启动。实物工件来自经 typecheck/test/build 验证的代码快照，打包器记录了实际编译输入哈希；后续文件头说明集中维护。已有开发工作区数据不参与测试。
- 五次空库就绪 718、701、693、703、694 ms；离线重开 486 ms。每 150 ms 采样的进程树 RSS 最高 995.4 MiB，最慢退出 112 ms。六次均正常退出，残留进程数为 0。机器与夹具见[验收记录](../../../docs/evidence/desktop-p1-linux-x64/acceptance.json)。当前同机预算：五次启动最大 5 s、退出最大 3 s、RSS 最大 1536 MiB、归档最大 300 MiB、残留进程 0。
- 本机 SDK CLI 经回环模型传输替身完成两次请求和一次工具调用，付费模型请求为 0。真实原生网页和页面输入通过；交付物的 FileVista/PDF.js 用安装包本地 worker 渲染样例 PDF。在测试中，直接导航 PDF 的 Chromium 内置查看器只显示空壳，P1 产品内 PDF 阅读使用已验证的交付物预览。[PDF 预览](../../../docs/evidence/desktop-p1-linux-x64/installed-pdf-preview.png)
- `npm run check`、`npm test`（89 项）、生产前端与桌面构建通过。P1 用户试用和重跑入口见仓库根 README。下一阶段 P2 处理宿主与运行时恢复。

## 2026-11-20 · P2 / 窗口、运行时与恢复 · 已验证

- 桌面新增独立运行时监督和配对协议。实物 Arch 包 SHA-256 为 `eceb04537bad3b241e0f6a383e9075d6cf385d0cc7a70771d2c020ecc017c6a3`。新版 Linux 受控环境中 10 次冷启动加 1 次离线重开均正常退出。冷启动最慢 759 ms，空闲关闭最慢 106 ms，采样进程树 RSS 最大 1152.4 MiB，残留进程为 0。[安装态验收](../../../docs/evidence/desktop-p2-linux-x64/installed.json)
- `scripts/smoke-desktop-recovery.mts` 对同一安装件验证第二次启动、端口占用、活跃写者保护、拒绝旧宿主协议和未配对 HTTP。真实 SDK 走回环替身，待审批时强杀运行时，重启看回原会话并拒绝旧审批和旧任务重放。执行中关闭耗时 1038 ms，重新打开保留正常关闭产生的中断记录。测试以固定选择驱动原生对话框的重试按钮回调。[恢复证据](../../../docs/evidence/desktop-p2-linux-x64/recovery.json)
- 开发过程 review：用 P1 的安装态脚本验证十次循环及原功能，只增加一条故障脚本覆盖 P2 特有行为。第一次归档期间修改了打包输入，导致压缩工作作废。下个阶段先用隔离构建副本验证修改，输入稳定后再压缩归档。故障脚本把 3 秒关闭预算和持久记录写为断言，省去重复人工判断。

## 2026-11-20 · P3 / 数据迁入引擎 · 已验证

- 使用 P1 包内运行时写出隔离数据，用新版随包 Node 执行迁入。新版 Electron 正常打开迁入项目，P1 打开回退副本，源数据库字节一致。`tests/data-migration.test.ts` 另覆盖附件、交付物、占用、已存在目标和损坏数据的处理。[迁入记录](../../../docs/evidence/desktop-p3-linux-x64/migration.json)
- 原生 `--import-data` 进入向导使用的独立 profile。隔离 X11 无法通过外部键盘驱动选目录，还需验证系统对话框完整流程。
- 开发过程 review 保留一条实际 P1 到新版再到 P1 副本的恢复链路，复用它检查源库和备份。将失败条件集中到临时 SQLite 测试，避免每种错误都重复执行原生对话框。

## 2026-11-20 · P4 / 原生浏览器

- 受控浏览器移入 `desktop/browser/`。旧 Playwright 配置在服务启动时补记 provider。浏览器 IPC 从运行时接收请求、运行标识和取消消息。
- 隔离 Electron 的真实 SDK 从固定的 Agent 标签完成读取和截图，用户仍可查看另一个标签。人工接管取消了未返回的本地网页导航，交还控制后 Agent 目标与用户选择一致。[验证记录](../../../docs/evidence/desktop-p4-linux-x64/tabs.json)
- 开发过程 review 使用两标签的一条链路覆盖工具发现、页签目标、截图落盘和慢导航交接。工具轨迹显示卡点在后台截图，后续仅重跑这条用例。真实账号登录和 Wayland 交互归安装件验收。

## 2026-11-20 · P5 / Agent 桌面执行

- 真实 Electron 和 SDK 通过回环模型夹具展示待审批消息。批准前测试文件不存在，用户点击「允许本次操作」后文件内容与审批一致，流式回复出现在对话。下一轮在同一个 SDK 会话续接，收到完成消息。[界面验收](../../../docs/evidence/desktop-p5-linux-x64/agent.json)
- 开发过程 review 复用 P2 的执行中停止和审批失效、P4 的自动 MCP 发现和截图交付，新增一条正向审批及续接验收。后续复用该组证据验证桌面运行时，真实付费模型依相应授权进行。

## 2026-11-20 · P6 / 桌面文件操作

- 安装件完成真实写盘、取消未创建文件、定位已保存副本和消息框拖入附件。系统选择和定位接口的返回由隔离测试提供。Web 沿用原浏览器入口。[验证记录](../../../docs/evidence/desktop-p7-linux-x64/workflows.json)
- 开发过程 review 将拖入、粘贴和文件选择收敛到同一上传流程。交付物卡片和预览共用另存组件。一次验收覆盖保存取消、内容一致和定位，避免重复测试两处入口。

## 2026-11-20 · P7 / Linux x64 本地发布验收

- Arch 归档 299,490,953 字节，SHA-256 `a8fc8aac7d2169b894771916f3cc022b84c8ccc42f397d6c44913148fd584c47`。十次冷启动最慢 758 ms，峰值进程树 RSS 1153.7 MiB，常规退出最慢 108 ms，连同离线重开共 11 次退出，残留进程为 0。[安装态记录](../../../docs/evidence/desktop-p7-linux-x64/installed.json)
- 同一构建通过实际点击人工接管、后台标签截图、聊天审批和续接、文件与诊断操作。迁入向导以测试给出的路径和确认选择运行，P1 数据字节保持一致。新版新建会话后，旧版重新使用迁入前的副本，该副本包含旧数据。模型使用回环夹具，付费调用为 0。[功能记录](../../../docs/evidence/desktop-p7-linux-x64/workflows.json)
- 开发过程 review 核对了发布候选的真实按钮，发现繁忙态阻塞接管并修复。验收脚本通过点击新手弹窗的关闭按钮消除焦点竞争，复用同一归档。压缩级别从 19 调整为 10 缩短本地打包，两个归档仍低于 300 MiB。
- Windows 与 macOS 复用宿主路径处理，需要对应平台构建和系统功能验收。

## 2026-11-20 · P7 / 第三方许可复验

- 复核锁定版本的 npm 归档与上游许可。将 `fastdom`、`strictdom` 的发布包许可章节和 `react-remove-scroll-bar` 后续补充的上游 MIT 文本纳入 Arch 和便携包。安装态复验通过，十次冷启动最慢 758 ms，正常退出最慢 110 ms，残留进程为 0。[来源](../../../docs/licenses/README.md) · [归档校验与安装态记录](../../../docs/evidence/desktop-p7-linux-x64/license-update.json)
- 开发过程 review 闲置进程核对后保留工作台。许可更新复用锁定依赖和 P7 安装态脚本，以上一轮记录保留功能证据。对外分发仍需应用及第一方 `@atelier/markdown` 的许可声明和发布授权。

## 2026-11-20 · P7 / Wayland 缩放与弹窗复验

- 用安装件启动独立工作台，强制使用原生 Wayland，启用 Chromium 沙箱。在 1440×960 的测试窗口打开本地网页，将工作台页面缩放从 100% 调到 125%。修复前，原生视图直接采用 CSS 坐标。修复后，宿主按页面缩放比例换算并将视图裁到内容区域，四项坐标与尺寸误差均在 2 像素内。模型与网关设置弹窗打开时移除原生视图，关闭后恢复网页。[安装件与坐标实测](../../../docs/evidence/desktop-p7-linux-x64/wayland.json)
- 对重建的 Arch 包复用 X11 安装态脚本。十次冷启动最慢 762 ms，正常退出最慢 106 ms，残留进程为 0。Wayland 复验使用本地网页夹具，窗口缩放由测试工具设置。

## 2026-11-20 · P8 正常退出准备

- 桌面宿主通过私有 IPC 断连触发运行时的正常退出。宿主等待子进程退出，超时后保留强制清理。恢复脚本支持 Windows 和 macOS 安装目录。当前在 Linux 安装件上复验通过，SDK 运行中关闭耗时 1,039 ms，重开后可读到明确的中断记录。十次冷启动最慢 787 ms，常规退出最慢 106 ms，残留进程为 0。付费模型调用为 0。[最终归档与恢复记录](../../../docs/evidence/desktop-p7-linux-x64/ipc-shutdown.json)
- 开发过程 review 复用安装件故障脚本验证已有的断连清理，不再增加 IPC 消息。首轮打包复验发现单等 `close` 会卡住 Electron。后续先在隔离安装目录验证 `exit` 处理，再重建最终归档。Windows 和 macOS 本机打包与图形会话验收待对应平台环境。

## 2026-11-20 · P4 / 桌面内置浏览器工具

- 桌面按项目直接登记原生浏览器工具，结合人工接管及逐次审批。测试项目配置了零个 MCP 扩展。真实 SDK 通过回环替身验证导航、接管和交还后重新观察、批准一次点击，以及截图作为 PNG 交付物保存。单独的 CDP 键盘夹具完成输入替换和表单提交。付费调用为 0。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/native-browser.json)
- 开发过程 review 复用安装态夹具与现有审批系统。第一次点击虽然返回成功，网页状态没有变化。用一个隔离 WebContentsView 复现了原生输入钩子拦截 CDP 事件，修复后以点击计数和截图像素判定通过。授权与撤销竞态用临时 SQLite 测试覆盖。

## 2026-11-20 · 候选构建与桌面切换

- 从同一 Linux 工件装配 Windows x64 和 macOS arm64 候选 ZIP。在 Linux 核对发行输入哈希、运行时资源、PE 和 Mach-O 架构及 ZIP 完整性。两个目标系统的运行验收留待后续。[构建证据](../../../docs/evidence/desktop-platform-previews.json)
- 用隔离项目运行旧版和新版 Linux 安装件，正常关闭旧版并确认单写者锁释放。新版使用同一个数据根，成功读回项目、会话、草稿、网关与模型设置以及项目浏览器分区数据。[切换证据](../../../docs/evidence/desktop-p7-linux-x64/same-data-upgrade.json)
- 开发过程 review 复用已筛选的 Linux 工件与 Electron Packager，省去两套资源收集流程。在一次同目录切换用例同时验证会话、配置和浏览器分区。Windows 与 macOS 本轮各交付一份候选构建，持续开发和回归优先放在 Linux。

## 2026-11-20 · 浏览器面板与全工具自动化

- 浏览器标签和地址占两行，共 80 CSS px。授权移入设置，打开时临时隐藏原生网页，关闭时恢复同一视图。Wayland 实测 1280×800、1440×900 与 125% 缩放。[决策](../../../docs/decisions/2026-11-20-task-automation.md)
- 自动化仅作用于当前任务，通过统一审批服务处理本轮已获授权的工具。安装态用真实 SDK 与回环夹具执行 6 次工具调用，核对网页点击、文件内容、本地 MCP 调用和三条自动审批记录。受控修改仍显示逐次审批。后端 105 项、前端 35 项通过，模型和搜索付费请求均为零。[归档与验收](../../../docs/evidence/desktop-p7-linux-x64/task-automation.json)
- 正常关闭旧桌面并等待写锁释放。新版使用同一数据目录、界面地址和浏览器 profile。比对确认原有项目、14 个会话、2 份非空草稿与设置完整。
- **开发过程 review**。首轮过早构建遇到未完成的前端类型改动，下次先冻结产品代码再打包。夹具先发现 MCP 工具再授权，手动地址栏测试放在 Agent 用例后执行。浏览器点击在面板打开时核对实际效果。面板隐藏时的点击问题记入本轮证据。安装态发现的草稿模式问题已由服务端修复并加入回归。最终为这一处产品修复重建归档，复用相同浏览器 UI 的 Wayland 数据。

## 2026-11-20 · 长任务执行

- 网页检索实测跑满默认 16 轮后没有回复。新任务默认持续执行到完成或停止。运行时停用总轮数、总时长及 SDK 固定费用估算上限。用户可以在设置中启用总轮数和总时长限制，旧的自定义上限会继续生效。[决策](../../../docs/decisions/2026-11-20-long-tasks.md)
- Linux 安装态从 Composer 发送任务，实际完成 17 次工具调用并收到最终文本。后端 106 项、前端 35 项回归测试通过。旧桌面退出后用同一数据目录和浏览器 profile 打开新版，数据库记录逐表相符。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/long-tasks.json)
- **开发过程 review**。扩充既有回环场景跨过 16 轮并核对最终文本，复用原有安装态和停止用例。首轮增加了工具步骤，离线重开仍断言旧请求数，改用共享计数后直接复验原工件。下次工具编排变化时同步更新其重开断言。

## 2026-11-20 · 会话级运行模式

- 运行模式保存到会话草稿。实际执行时继续记录当轮审批策略，新会话默认只读。采用 shadcn Select 展示运行模式，自动模式的搜索费用改为按需设置，仅下一次发送生效。[决策](../../../docs/decisions/2026-11-20-session-approval-mode.md)
- Linux 安装态从输入区连续发送两轮，都保持自动化，重开后确认模式恢复并验证另一会话仍为受控修改。后端 106 项和前端 35 项通过。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/session-approval-mode.json)
- **开发过程 review**。沿用原有草稿保存队列和安装态用例，在原场景追加一轮发送及重开验证。首轮回归的整份草稿断言受空扩展字段影响，改为直接核对审批偏好和实际运行模式。

## 2026-11-20 · 会话模型选择

- 发送键旁的 shadcn Select 保存会话选定的模型。模型目录合并工作台默认值、Shunt 路由和本机 Codex 可见模型。在本机配置合并后得到 10 项。[决策](../../../docs/decisions/2026-11-20-session-model-picker.md)
- Linux 安装态选择第二个模型并核对真实 SDK 发给回环网关的请求，随后离线重开会话确认选项恢复。142 项回归通过，正式实例完成同目录切换。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/session-model-picker.json)
- **开发过程 review**。复用会话模式的连续发送场景核对模型 ID。首轮仅用显式路由导致两项，用户确认需要补全目录后使用 `model/list`。将目录查询、协议兼容验证与无费用的安装态 SDK 检查各保留一次。

## 2026-11-20 · 内置 Shunt 与会话推理深度

- Linux 安装包附带固定版本的 Shunt。正常启动时使用独立的回环端口和工作台目录中的 Shunt 配置。原有账户目录可复用。设置提供首次 ChatGPT 登录和外部网关选择。[决策](../../../docs/decisions/2026-11-20-managed-shunt.md)
- 模型菜单收为单行列表。发送区支持选择并保存会话推理深度。真实 SDK 的回环请求收到所选 `xhigh`，重开后恢复该选择。[推理设置](../../../docs/decisions/2026-11-20-session-reasoning-effort.md)
- 最终 Linux 安装态验证无账号启动、拒绝匿名请求及同目录配置持久。正式实例复用已有账号目录，确认本地网关可达。142 项项目测试和 7 项独立登录进程检查通过。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/managed-shunt-and-effort.json)
- **开发过程 review**。先用 SDK 回环探针验证别名的 effort 参数，再纳入既有安装态用例。复用安装态启动器检查内置与外部网关。首轮实机截图发现发送键换行，移走重复键盘提示后，用同排位置断言复验。

## 2026-11-20 · 会话网页链接

- 桌面会话点击网页链接后选择打开位置。内置入口新建项目标签并进入人工控制，外部入口将校验过的网址交给系统浏览器。[决策](../../../docs/decisions/2026-11-20-chat-web-links.md)
- Linux 安装态验证新标签实际导航、原标签保留、系统打开命令收到完整网址，以及 Enter 与 Esc 的焦点行为。142 项项目测试通过。完成同目录桌面切换并核对会话、草稿和设置。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/chat-web-links.json)
- **开发过程 review**。沿用已有私有浏览器 IPC、shadcn Dialog 和回环 SDK 场景。在现有回复夹具追加一条本地网页链接，同一个用例验证两个打开入口。外部打开使用隔离的 xdg-open 记录器。

## 2026-11-20 · 内置浏览器下载

- 处理人工浏览中的附件链接。下载记录按项目展示，文件保存到系统下载目录，同名加序号。工具栏保留原有两行布局。[决策](../../../docs/decisions/2026-11-20-browser-downloads.md)
- Linux 安装态用本地 `target="_blank"` Excel 响应验证进度、保存路径、实际字节内容、原公告页和同名文件保留。142 项项目测试通过。旧实例正常退出后完成同目录切换。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/browser-downloads.json)
- **开发过程 review**。复用既有原生网页用例。复验修正了隔离环境的下载目录回退和夹具字符集。最终让附件从原受控网页视图发起，并单独断言服务器收到请求，缩短从界面失败定位到导航链路的过程。

## 2026-11-20 · 网页附件文件名

- 官网链接展示中文标题，响应以编号式 URL 文件名提供附件。工作台对可匹配唯一网页标题的编号文件使用标题和原文件后缀。[决策](../../../docs/decisions/2026-11-20-browser-download-filenames.md)
- Linux 安装态以同样的 Excel 编号链接验证中文路径、实际文件内容和同名序号。142 项回归通过，完成同目录桌面切换。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/browser-download-filenames.json)
- **开发过程 review**。先核对原站响应头和链接，再把现有附件夹具换成同样的命名结构，复用进度、落盘和同名保护断言。

## 2026-11-20 · 下载列表和文件预览

- 下载记录改为紧凑文件行。按项目下载标识读取完成文件，交给 FileVista 预览。电子表格使用独立 worker 读取 XLS 和 XLSX。系统打开走本地默认应用。[决策](../../../docs/decisions/2026-11-20-browser-download-previews.md)
- Linux 安装态实际下载 BIFF2 工作簿，验证 FileVista 单元格、系统打开器收到的文件路径和跨项目读取拒绝。142 项回归通过，完成同目录桌面切换。[验收记录](../../../docs/evidence/desktop-p7-linux-x64/browser-download-previews.json)
- **开发过程 review**。复用附件下载场景，将原来的内容替身换成可解析工作簿，继续检查进度、文件字节和同名保护，再追加预览及打开动作。

## 2026-11-20 · 浏览器超时与状态恢复

- Electron 管理操作时限和恢复，导航允许 60 秒，其余操作 30 秒。异常作为独立工具结果写入轨迹并在聊天显示。健康标签保留页面和表单，必要时只替换失效标签，输入结果不确定时提示核对。[决策](../../../docs/decisions/2026-11-20-browser-timeout-recovery.md)
- 真实 Electron 验证 31 秒慢页面完成、挂起操作恢复及网页进程退出。Linux 安装态真实 SDK 收到导航超时，随后成功读取原页并完成回复。142 项回归通过。桌面完成同目录切换，核对 14 个会话、2 份未发送草稿和设置。[验收](../../../docs/evidence/desktop-p7-linux-x64/browser-timeout-recovery.json)
- **开发过程 review**。独立夹具并行验证慢导航和输入截止，安装态复用已有浏览器任务覆盖用户提示。夹具的请求计数断言修正后，直接复验同一归档。后续增减工具时共同核对夹具、初次运行和重开计数。

## 2026-11-20 · 会话消息队列

- 会话运行中可继续按 Enter 发送。待处理消息保存在 SQLite，上一轮清理后按序启动。输入区可撤回，重启后可继续原队列。[决策](../../../docs/decisions/2026-11-20-session-message-queue.md)
- 安装态真实 SDK 验证三轮顺序执行、后续轮获取前一轮回复及撤回生效。151 项回归通过。同目录桌面切换完成，14 个会话、2 份草稿和设置通过核对，数据库升级到 v4。[验收](../../../docs/evidence/desktop-p7-linux-x64/session-message-queue.json)
- **开发过程 review**。隔离运行时测试验证持久化和执行交接，安装态集中验证 Enter、实际 SDK 上下文和结果。模型夹具将历史误作本轮输入时，修正匹配范围并复用原归档。下次新增多轮场景优先从本轮输入块匹配。

## 2026-11-21 · 文档附件与实时补充

- 文档通过本机流式写入，保留原件与会话引用。表格大于 20 MiB 时提供原件下载，Agent 通过授权文件路径分段读。待处理区使用紧凑布局，可立即插入符合本轮设置的消息。[决策](../../../docs/decisions/2026-11-21-document-attachments-and-live-input.md)
- 安装态验证 22,475,193 字节 XLSX 的原件下载与第 245 行读取。使用回环模型确认补充消息在同一 SDK 运行收到回执。193 项回归通过。同目录切换后 14 个会话、2 份草稿和设置通过核对，数据库升级到 v5。[验收](../../../docs/evidence/desktop-p7-linux-x64/document-attachments-and-live-input.json)
- **开发过程 review**。解析边界主要通过隔离文件夹具验证，安装态集中检查大文件上传、原件一致性、SDK 本地读取和真实插入。保持回环模型按本轮任务匹配，复用前序桌面验收。

## 2026-11-21 · ORM 架构与开发约定

- [ORM 架构决策](../../../docs/decisions/2026-11-21-orm-architecture.md)规定仓储接口、用例事务、Drizzle schema、迁移及运维的职责。数据库路径规则已关联 AGENTS.md，架构检查对生产源码中的已有 SQL 指纹和新增依赖逐处核对。
- 随包 Node 24.21.0 在临时库通过稳定驱动的读写、条件领取、回滚和在线备份验证。仓库类型及架构检查、196 项回归和构建通过。产品接入以会话快照作为首个迁移用例。
- **开发过程 review**。先查 npm 稳定版导出，再用实际 Node 验证驱动，提前发现文档与稳定发行入口的差异。将实际工作区数据迁移和桌面发行验收留在首个产品接入阶段。

## 2026-11-21 · ORM 首批会话快照

- `GET /api/sessions/:id` 在共享连接的同步读取事务中装配 Drizzle 记录、队列和智能体状态。v6 派生列让六类记录按会话索引查找，并保留已有 rowid 顺序。[实现决策](../../../docs/decisions/2026-11-21-orm-architecture.md)
- 临时 v5 数据与本机数据库副本均已验证等价性，14 个已有会话的记录内容及顺序逐字段一致。100 个会话、1 万条消息的热库测试中，目标会话 100 条消息的记录读取中位值由 6.10 ms 降为 0.61 ms。201 项回归和 Linux 安装态验收通过。[验收](../../../docs/evidence/desktop-p7-linux-x64/session-snapshot-orm.json)
- **开发过程 review**。从真实仓储生成的查询检查六个索引，复用副本演练覆盖旧库内容。打包验证先发现 npm 包缺少许可证正文，随后发现驱动探针缺少 FROM 表。下次在独立依赖目录直接运行和归档相同的探针，再启动打包。

## 2026-11-21 · 会话子代理

- 主会话通过原生 SDK 前台委派最多两个子代理。运行时按执行者绑定工具、审批和提交结果。每项任务可在本轮消息或执行轨迹单独展开。SQLite v7 保存子任务并在异常退出后保留中断状态。见[决策](../../../docs/decisions/2026-11-21-subagents.md)。
- 212 项回归通过。通过 Linux 安装工件的独立数据根，验证真实 SDK 委派、两个待审批任务的独立展开、按任务允许和拒绝、实际文件内容及离线重开。使用回环模型夹具完成六次请求。见[验收记录](../../../docs/evidence/desktop-p7-linux-x64/subagents.json)。
- **开发过程 review**。先用最小 SDK 探针确认同批并行和 hook 参数透传，再复用同一模型夹具测试应用执行器和桌面操作。安装验证用健康检查和消息发起响应快速区分 UI 定位失败与网关问题。

## 2026-11-21 · 子代理调度修正与站点搜索

- 按用户要求移除 Atelier 的两任务上限。同批委派当前由原生 Claude SDK 调度。项目规则要求行为偏离 Claude CLI 时先说明并取得用户确认。真实 SDK 夹具卡住首批响应直到收到三个子调用，并验证三项审批各自归属。
- 在现有 Shunt 路由上加入按域名的托管搜索。SDK 子代理调用搜索工具时记录其结果。真实网关分别返回 `baidu.com` 和 `toutiao.com` 来源。安装态完成三个子代理同时等待审批、两个子代理分别搜索与重开历史，213 项回归通过。见[搜索决策](../../../docs/decisions/2026-11-21-subagent-web-search.md)。
- **开发过程 review**。核对网关配置约束后用现有 `/v1/messages` 实测，复用订阅授权。扩大原有安装态夹具，一次启动覆盖三路调度、两站搜索和重开。

## 2026-11-21 · 消息操作与会话分支

- 用户消息可复制或带入输入框编辑，助手回复可复制 Markdown 或引用到草稿。原「只读续接」改为「检查任务进度」。从已记录 SDK 切点的消息创建独立分支，侧栏标记分支，头部提供来源定位。会话分支共用项目当前目录。见[消息分支决策](../../../docs/decisions/2026-11-21-message-branches.md)。
- `npm run check`、`npm test`（155 项运行时测试、65 项前端测试）、`npm run build` 和 `npm run build:desktop` 通过。用隔离数据根和回环模型执行 `tests/session-forks.test.ts`，覆盖同节点 A/B、请求重试、未完成创建清理、来源删除后重启、分支独立续接和配置变化后的上下文恢复。Linux Electron 开发构建以独立数据和 profile 操作真实窗口，在 1280×800 核对真实复制粘贴、创建分支和来源定位，在 1440×900 检查分支列表和会话内容。桌面夹具完成三次回环模型请求，创建分支时没有模型请求。工作区验收，文件说明待验收提交后集中核对。
- **开发过程 review**。复用同一个回环模型夹具验证 SDK、HTTP 和真实桌面。先在运行时验证截取范围和原会话删除后的续接，再检查桌面交互。复制从用户输入框的实际粘贴判定，测试断言只记录匹配结果。
- 图标尺寸修复在共享 Button 的图标变体上覆盖文字按钮内边距。旧样式将编辑和发送 SVG 分别压到 2 和 6 CSS 像素宽。Chromium 回归使用真实 CSS 层级，Electron 在 1280×800 和 1440×900 分别测得 15 和 20 CSS 像素，编辑按钮可带入正文，发送按钮随输入正确启用。220 项回归通过。
- 旧会话打开时恢复可唯一核对的 SDK 切点。`tests/session-forks.test.ts` 移除示例消息的切点，经真实 SDK 和回环替身恢复后建立分支。隔离 Electron 重开同一份旧数据，验证分支创建、切点排除后续内容、返回来源与独立续聊。220 项回归、类型检查及桌面构建通过。原桌面正常关闭后用原数据目录重开，核对 1 个项目、16 个会话及 3 条设置记录，当前打开的会话恢复了 6 条消息切点。
- 补充恢复旧 Skill 消息。按照原生请求的扩展名称、类型和完整用户正文核对提示，再与完整回复做双向唯一匹配。回环测试实际提交 Skill 后移除切点，确认重新加载能恢复并创建分支。220 项回归及桌面构建通过，隔离 Electron 复验创建分支及定位来源，实际工作台打开截图对应的会话后，两条消息均恢复切点。
- 侧栏按会话的来源 ID 组织分支，分页按根会话分组，搜索保留命中会话的祖先。来源已删除的分支继续作为顶层会话可访问。223 项回归通过，生产和桌面构建通过。隔离 Electron 用回环夹具验证三层会话、键盘展开收起、搜索和切换。原桌面用原数据重开，保留 19 个会话及其中的两个分支。
- **开发过程 review**。复用已加载的会话列表及原生分支夹具。用三个纯数据用例覆盖排序、搜索和缺失来源，再在同一次桌面运行中检查展开和导航。

## 2026-11-21 · 对话回退

- 可验证的历史消息提供「回退对话到此处」。确认后从该消息继续，原会话收在侧栏「回退前」。续聊使用当前工作目录。回退前的草稿、审批和交付物留在原会话。见[回退决策](../../../docs/decisions/2026-11-21-conversation-rewind.md)。
- `tests/session-forks.test.ts` 覆盖历史切点、并发历史变化、活动运行、排队消息、重复请求、源草稿与文件内容。`npm run check`、`npm test`、生产和桌面构建通过。隔离 Electron 验证 Esc 取消与焦点恢复、打开旧版本读取原草稿、按原生切点续聊、项目文件保留当前内容。模型走回环替身，共三次请求。原数据桌面重开保留 19 个会话。
- **开发过程 review**。复用分支创建和恢复流程，用一条原生续聊测试对照历史正文和实际磁盘文件。文件头集中维护在验收提交后进行。

## 2026-11-22 · 项目导航、布局与模型目录

- 侧栏按项目展示会话及分支。用悬停或键盘打开会话菜单，重命名、归档、恢复或删除目标会话。右栏去掉重复的项目和会话管理区，汇集当前运行、审批和使用信息。Chromium 夹具覆盖两项目归组、回退历史搜索、非当前会话管理、焦点和折叠。
- 新增可拖动的分隔条、左栏折叠与布局默认值。尺寸随窗口临时调整，用户选择的宽度保存在工作区数据库。Electron 验证 232/320 初始宽度、拖动、键盘调整、48 像素折叠宽度、默认值写入及重开、窄屏抽屉和原生浏览器位置。见[布局决策](../../../docs/decisions/2026-11-22-workspace-layout.md)。
- 本机复现时 Shunt 的路由正常，Codex 补充目录在旧总预算内超时。调整时间预算、缓存和错误反馈后，同一个本机网关连续三次给出 10 个模型。回归覆盖 5.1 秒返回、失败恢复、分页和账号来源隔离。见[诊断和修复](../../../docs/decisions/2026-11-22-model-discovery-recovery.md)。
- **开发过程 review**。左栏、右栏和 Shunt 三路并行，主会话接线。单独用可调整的 Electron 测试窗口验证几何，复用路由和真实 `model/list` 对照合并结果。

## 2026-11-22 · 开发桌面托管 Shunt

- 开发桌面使用 Linux 打包产物中的 Shunt，复用主进程的启动与退出流程。隔离 Electron 验证自动启动、模型目录返回 10 项、关闭窗口后网关退出。当前桌面以原数据重开并选中内置网关，临时外部服务已停。停止后再次验证内置网关健康和 10 项模型目录。244 项回归及前端和桌面构建通过。[托管网关决策](../../../docs/decisions/2026-11-20-managed-shunt.md)
- **开发过程 review**。先核对当前窗口的启动类型及实际连接，再使用隔离 Electron 验证网关随窗口结束。保留外部服务到切换验收完成后再关闭。

## 2026-11-22 · 独立设置页与工作台路由

- 设置打开独立页面，分为模型与网关、工作区布局、诊断。默认模型取已保存网关的目录，仍可手动输入。TanStack Router 管理工作台页面、会话子页和设置路径。SQLite 保存最后位置及最近会话，重开时恢复。见[路由决策](../../../docs/decisions/2026-11-22-workspace-routing.md)。
- 247 项回归、类型检查、前端及桌面构建通过。隔离 Electron 验证两个会话子路由、前进后退、默认模型选择与保存、设置子页、刷新以及运行时换端口后的恢复。侧栏 Chromium smoke 通过。已用原数据重开桌面，确认项目和会话数量及内置网关选择一致。
- **开发过程 review**。在一次 Electron 夹具中完成路由导航、表单和重启验收，分页和失败场景由聚焦测试负责。

## 2026-11-22 · Magpie 模型

- 会话及默认模型选择器增加 Magpie 分组。选择后，运行时通过本机 Magpie 发送原生 Anthropic Messages 请求。内置 Shunt 继续提供同一目录中的 Shunt 模型。[接入决策](../../../docs/decisions/2026-11-22-magpie-model-gateway.md)
- 实际 Magpie 目录返回 57 项。隔离 Electron 验证两个选择器和会话模型持久化。原生 SDK 回环测试覆盖网关分流、原始模型 ID 和离线失败。249 项测试及构建通过。原工作区重开，确认内置 Shunt 仍选中，Magpie 目录可读。
- **开发过程 review**。先通过目录和空请求确认网关接口，复用原生 SDK 替身验证发送，再用 Electron 连接真实目录。

## 2026-11-22 · Magpie 独立接入开关

- 「设置 → 模型与网关 → 允许接入 Magpie」默认关闭，独立保存。运行时在目录发现、发送、重试和队列投递前判断当前设置。原默认或会话模型保留并标明不可用。已经启动的运行仍可通过停止按钮结束。[接入决策](../../../docs/decisions/2026-11-22-magpie-model-gateway.md)
- `npm run check`、`npm test`（170 项运行时、79 项前端）、`npm run build` 和 `npm run build:desktop` 通过。回环验证保留的默认模型、禁用拦截、在途目录取消、SQLite 重开和真实 SDK 的网关分流。隔离 Electron 用键盘及鼠标切换，开启后读取真实 Magpie 的 57 项，关闭后仍可选夹具 Shunt，重启后保留关闭状态和原默认模型。实际桌面以原数据与 profile 重开，1 个项目、3 个会话和内置 Shunt 配置仍可用。
- **开发过程 review**。用同一隔离 Electron 场景验证真实目录、两个选择器和重开。用回环夹具验证发送拦截，目录竞态在测试中显式挂起请求，减少等待和付费调用。
- 文件说明复核基于 12 份源码的验收后哈希快照。更新 7 个文件头，12 个文件的 `check:headers` 全部通过。

## 2026-11-22 · 会话快捷插入与引用卡片

- 输入区 `Alt + Enter` 提交当前草稿并尝试把对应队列项插入当前运行。插入不兼容或未确认时可在待处理消息中查看。引用回复会生成正文输入上方的可移除卡片，随草稿保存并在发送时组成正文。[交互决策](../../../docs/decisions/2026-11-22-composer-quotes-and-insert.md)
- 249 项测试、类型检查、前端和桌面构建通过。Chromium 夹具覆盖 IME、幂等发送重试、卡片增删及插入失败。隔离 Electron 在草稿 PATCH 确认后关闭并重开，卡片和正文均恢复。真实 Agent SDK 对接回环网关替身，核对发送带引用正文和快捷键的实时插入回执。原桌面已使用原 profile 和数据重开，保留 1 个项目、4 个会话和原网关设置。SQLite 回退副本已通过完整性检查。
- **开发过程 review**。重启测试用可确认的草稿保存回执判断持久化完成。利用切窄的真实桌面复现提示隐藏，修复后复用同一流程检验可见性及投递。
- 首次文件说明复核超时，改用同一验收快照的相关片段后通过。更新 10 个文件头。13 个相关文件通过 `check:headers`，源码正文与验收快照一致。

## 2026-11-22 · 桌面本机执行与进展恢复

- 普通 Linux 桌面新会话默认使用 SDK 原生 Shell、文件和技能工具。既有会话从运行模式选择「本机信任」。队列与续接固定执行器版本。子任务可单独停止，归属该分支的在途审批随之取消。运行恢复带入已有来源、工具结果指针和未确认的修改。[决策](../../../docs/decisions/2026-11-22-native-harness.md)
- 真实 Electron 使用临时项目和回环模型响应验证项目外文件修改、长命令停止和重开后恢复。真实 SDK 测试还覆盖项目 Skill 调用以及只停止指定子任务。`npm run check`、`npm test`（229 项运行时/工具链、83 项前端）、`npm run build`、`npm run build:desktop` 通过。备份 SQLite 并通过完整性检查后，用原 profile 打开新版，1 个项目、4 个会话和网关配置已核对。[验收数据](../../../docs/evidence/desktop-p7-linux-x64/native-harness.json)
- 历史轨迹离线回放在第 236 秒、149 秒分别触发首次重复来源提示，两轮均恢复了 16 个待核实来源。默认向原生模型提供提示。持续确定失败时自动停止子任务可用 `ATELIER_HARNESS_PROGRESS=pause-branch` 启用。真实模型三方对照须使用获授权的模型调用预算。[评测入口](../../../docs/harness-eval.md)
- **开发过程 review**。从同一工作区复用旧队列、回执、SDK hook 和 SQLite。先以回环传输走通不可伪造的文件与进程状态，再用历史事件调校提示。跨任务评测加入正常重复、等待与回执未知等对照，避免把调用次数误作质量。

## 2026-11-22 · 并行分支停滞提示投递

- 主会话和子分支共享重复证据，各自记录反馈回执和冷却时间。执行轨迹区分待投递与加入 SDK 工具回执。处于冷却期的提示可在后续相同停滞再次出现时投递。
- 使用真实 Agent SDK 和回环模型验证两个并行前台分支相隔 1 ms 触发同一目标的停滞提示。两条后续模型请求各自携带对应工具的提示。231 项运行时测试和 83 项前端测试通过，类型检查、前端与桌面构建、隔离 Electron 验收通过。已切换原桌面，核对 1 个项目、4 个会话及网关设置。
- **开发过程 review**。确定性时钟重放第 64 秒和第 66 秒的双分支故障，SDK 测试检查下一次模型请求中的实际提示和工具 ID。
- 文件说明复核完成，更新 3 个文件头，4 个相关文件通过 `check:headers`，源码正文与验收快照一致。

## 2026-11-22 · Bash 前台命令的重复输出提示

- 每个分支独立比较前台 Bash 的执行参数和完整输出，达到既有停滞阈值后通过工具回执给出建议。文件编辑、命令变化或输出变化会重新计数，后台任务、截断回执和中断回执另行处理。[执行契约](../../../docs/decisions/2026-11-22-native-harness.md)
- 真实 SDK 配合回环模型运行三次 `pwd`，验证停滞提示已进入下一次模型请求。并发分支、文件修改前后的测试重跑和后台作业回执均有定向覆盖。235 项运行时及工具链测试、83 项前端测试、类型检查、构建和隔离 Electron 验收通过。当前桌面已用原 profile 和数据重开，核对 1 个项目、4 个会话和网关设置。
- **开发过程 review**。先回放十次相同命令确认漏报，再使用真实 SDK 的输出结构验证模型能看到提示。虚拟时钟覆盖触发时长，缩短了验收等待。

## 2026-11-22 · 会话跨轮恢复

- SDK 重建时，运行时在同一读取事务内按会话读取运行、消息和工具记录，生成包含用户要求与更正、来源、回执和待核对操作的摘要。各类资料保留早期锚点和近期记录，省略情况随摘要传入。最近对话按 UTF-8 字节预算选取。分支继承可见前缀，工具记录按实际会话和执行范围筛选。
- 四轮真实 Electron 和 Agent SDK 验收使用本机回环模型。早期 Read/Edit、进度追问、停止 Bash、重开恢复依次执行。恢复后的独立检查点包含早期和近期约束、三轮 ID 和真实工具 ID，Bash 操作标为待核对，文件和命令执行次数验证通过。241 项运行时与工具链测试、83 项前端测试、类型检查及构建通过。已备份 SQLite 并用原 profile 重开，1 个项目、4 个会话和网关设置已核对。[验收数据](../../../docs/evidence/desktop-p7-linux-x64/native-harness.json)
- **开发过程 review**。直接解析恢复后最新模型输入中的检查点 JSON，并核对新的 SDK 会话 ID。这样可以区分检查点恢复与模型偶然在最近聊天文本中看到同一句话。

## 2026-11-22 · 消息内执行明细与按需浏览器面板

- 助手消息展示主助手的执行明细，运行中默认展开，历史记录按需展开。原生 Bash 和沙箱命令显示实际参数与回执，长输出可分页读取、下载。工具开始及结束事件关联具体工具记录，历史截断参数保留已记录内容。
- 会话默认使用整个中栏。停止和计划归会话，事件及用量归执行轨迹。会话变更记录按需打开，浏览器支持宽屏右栏、窄屏中栏和返回原轨迹位置。
- `npm run check`、`npm test`（241 项运行时与工具链、95 项前端）、`npm run build` 和 `npm run build:desktop` 通过。`node --import tsx scripts/smoke-tool-activity.mts` 在隔离 Electron 用回环模型启动真实 Bash，运行中展示完整 4,585 字符命令，结束后在原消息和结束事件核对 `branch=fixture`，浏览器关闭后返回原轨迹。已备份 SQLite 并用原 profile 重开桌面，核对 1 个项目、4 个会话和网关设置。
- **开发过程 review**。用同一工具 ID 串起开始事件、实际命令、回执和历史，复用真实运行记录。响应式测试等待分隔条与原生槽位状态同步，再测量同帧的边界。

## 2026-11-22 · 模型先读长输出摘要

- 长文本工具回执先保存在本地。工作台工具在模型侧提供有界摘录和按需读取指针。原生 Bash 成功文本和常用读取、搜索工具按 SDK 结构交付。原生失败 Hook 支持附加指针，非零退出 Bash 仍可能发送完整错误正文。见[执行契约](../../../docs/decisions/2026-11-22-native-harness.md)。
- 真实 SDK 0.3.326 配回环模型核对下一请求。原生 Bash 保存 33,561 个 UTF-16 码元，模型收到 1,039 个。5 次读取按 8,000 上限拼回原文。受控命令成功 / 失败、6,000 / 6,001 边界、默认页、未发放指针拒绝、原生 Read、Glob 与 Grep 的计数通过。
- 全套测试 349 项通过，1 项 WebFetch 真实 SDK 集成因缺少隔离网络夹具跳过，对应替换结构已有单元测试。`npm run check`、前端与桌面构建、隔离 Electron 消息内完整原文验收通过。已备份 SQLite、正常退出旧窗口，并在原 profile 启动新版，复核 1 个项目、4 个会话及保存的设置。
- **开发过程 review**。验证工具摘要时同时检查模型收到的回执与 system 角色的 Hook 上下文，并用省略位置的标记核对原文读取。字符数记录在各自的传输与存储边界。

## 2026-11-22 · 恢复原生 Read 的精确范围

- 同一批合成任务使用托管网关 `gpt-6.1-sol`、`medium` 复测。原生 Read 由 SDK 限幅并交付行范围，工作台仍保存回执。精确字段任务从 `Read → Grep → Read` 减为一次 `Read`，模型请求从 4 次减为 2 次，未缓存输入从 15,442 降至 9,128，含缓存读取的总输入从 29,266 降至 19,112，耗时从 15.5 秒变为 7.5 秒，答案正确。两项日志任务仍收到摘要并答对，构建日志复测多读一页。
- 真实 SDK 回环先复现 240 行范围被截为首段，再确认第 220–459 行完整到达模型。`npm run check`、前端与桌面构建通过。测试 349 项通过，1 项既有 WebFetch 集成用例跳过。隔离 Electron 验证命令日志的摘要和本地原文，桌面已用原 profile 重开并核对原有项目、会话和设置。
- **开发过程 review**。用同一个模型任务复测往返次数，以回环测试断言长范围到达模型。分开记录摘要策略和模型自主选择分页造成的波动。

## 2026-11-22 · 工具记录内的关键词定位和 Bash 日志保存

- `read_tool_output` 支持按字面关键词在可读日志内定位，返回命中行号、上下文和同一文本内的 UTF-16 偏移。默认回执分页继续使用已保存的 SDK 回执。Linux 桌面保存经运行、会话、项目和文件归属核对的 SDK 日志副本，单条最多 8 MiB。日志详情、分页和下载显示实际保存范围。
- 用 `gpt-6.1-sol`、`medium` 重跑同一合成构建诊断。模型用 `PHASE` 命中第 100 行，查询回执 796 个字符，一次定位到模块、原因和工单。与前次复测相比，模型请求从 4 次降到 3 次，含缓存读取的总输入从 34,198 降到 21,716，未缓存输入从 11,414 增至 14,548，耗时从 16.8 秒增至 18.2 秒。
- 真实 SDK 回环验证省略的日志中段能从关键词命中继续读取。真实 Electron 窗口对 217,623 字节日志翻 6 页定位中段，下载文件与原文一致。子任务记录归属、8 MiB 处的 UTF-8 字符边界、迁移、重开和删除均通过。完整测试 370 项通过，1 项既有 WebFetch 集成用例跳过。类型检查与前端、桌面构建通过。备份 SQLite 后以原 profile 重开，核对 1 个项目、4 个会话和保存的设置。
- **开发过程 review**。以模型真正收到的查询结果和 Electron 原生下载完成事件验收。显示日志和原始回执各自使用明确的分页坐标。独立审查任务因模型额度返回 429 中止，主会话完成复核和针对性修正。

## 2026-11-22 · OpenWiki 项目接入与文档更新

- 安装项目级 Claude Code Skill 与 MCP 配置。由当前会话按源码和测试更新 8 个既有页面，新增工作台导航与模型网关 2 页。OpenWiki 生成索引并记录 34 条事实。[接入与回退](../../../docs/decisions/2026-11-22-openwiki-host-integration.md)
- 宿主更新返回 `complete`。MCP 搜索、章节读取、42 个 Wiki 内链和 83 处源码证据引用已检查。`npm run check`、`npm test` 和 `npm run build` 通过。370 项测试通过，既有 WebFetch 集成用例因缺少可重复的本地传输夹具跳过。
- **开发过程 review**。沿用已有页路径和事实 ID，按运行时、UI 与网关入口复核改动。一次本地 MCP 会话完成更新及检索验证。

## 2026-11-22 · 中英文界面与文案门禁

- 设置页新增简体中文和英文切换，首次使用默认简体中文。界面词条随工件分发，Electron main 在启动运行时前读取 profile 偏好。切换即时更新 React、无障碍名称、页面标题、预览和后续打开的应用原生弹窗。[国际化决策](../../../docs/decisions/2026-11-22-ui-i18n.md)
- `npm run check` 包含 `check:i18n`。它检查常见 JSX 和原生文案入口、字典完整性、插值以及复数形式。全套测试 383 项通过。既有 WebFetch 真实 SDK 用例缺少本地传输夹具而跳过。Chromium 验证切换、未保存设置保留和刷新恢复语言，Markdown 实物包的中英消息可由 Node ESM 导入。
- 前端和桌面构建通过，Linux x64 便携包与 Arch 工件生成。许可清单见 `dist/linux/license-inventory.json`。隔离真实 Electron 通过英文切换、重开持久化以及运行时崩溃后重新连接。原生弹窗的已本地化参数由夹具截获核对。以原数据目录和默认 profile 重开正在使用的桌面，复核 1 个项目、4 个会话及原网关设置。重开前的 SQLite 备份通过完整性检查。
- **开发过程 review**。复用现有设置页夹具保留草稿与断言，单独用真实 Electron 覆盖只有主进程才能证明的恢复和跨端口持久化。第一次打包检测到词条并行改动后停止，最终从稳定输入重新生成。活动窗口正常关闭后，历史环境缺少有效显示参数，显式使用当前 Wayland 会话完成重开。

## 2026-11-23 · 会话内执行明细排版

- 折叠行优先显示工具名和已记录的说明，下一行预览命令或目标。展开后分区显示时间、参数与回执，长参数在区块内滚动。状态标签使用工作台主题色。
- `npm run check`、`npm test`、`npm run build` 和 `npm run build:desktop` 通过。383 项测试通过，既有 WebFetch 集成用例跳过。Chromium 复核 1280、1440、1920 像素视口及中英文标签。隔离 Electron 使用回环夹具验证调用展开、日志分页和下载。当前工作台的重启被权限审查拦截，需用户明确授权。回退只涉及本节对应的卡片渲染和样式，无数据迁移。
- **开发过程 review**。复用工具详情的视口测试与 Electron 日志夹具。第一次截图发现长参数挤占回执空间，调整后以滚动高度断言和真实窗口复验。

## 2026-11-23 · 完整工具输出弹窗

- 工具输出弹窗随视口扩展至 1080 CSS 像素。完整 JSON 默认缩进，读取工具的嵌套摘录单独展示，可切换原文。分页、下载和原始字符计数仍按原回执处理。
- `npm run check`、`npm test`、前端及桌面构建通过。387 项测试通过，既有 WebFetch 集成用例跳过。隔离 Electron 复核中英文标签、420/1280/1440/1920 像素视口、原文切换、焦点恢复及原有日志分页下载。回退范围为工具输出弹窗样式、展示格式和词条。
- **开发过程 review**。同一隔离窗口先走真实日志分页下载，再用固定 JSON 回执核对摘录与尺寸，避免引入外部模型或访问用户数据。

## 2026-11-23 · 工具卡片的命令分行

- 简单的单行 Shell 命令在外层分号处视觉换行，保留引号、转义及子命令内的文本。已有多行布局和复杂语法沿用原格式。显示分行不会改变选中或存储的命令文本。
- `npm run check`、`npm test`、前端和桌面构建通过。389 项测试通过，既有 WebFetch 集成用例跳过。隔离 Electron 确认同一原始命令显示为六行，并验证日志分页和下载。回退范围为工具详情的命令显示逻辑和样式。
- **开发过程 review**。用同一条浏览器断言检查视觉位置与选中原文，再用隔离窗口确认分行和回执在实际布局中的表现。

## 2026-11-23 · 引用所选文字

- 助手正文的同一消息内可跨段选取，松开指针后显示「引用所选」。支持 `Alt+Shift+Q` 添加片段、Esc 收起和原有整条引用。片段按来源和选文去重，并可独立移除。旧格式草稿和提交接口兼容。[决策记录](../../../docs/decisions/2026-11-22-composer-quotes-and-insert.md)
- `npm run check`、`npm test` 和前端、桌面构建通过。389 项测试通过，既有 WebFetch 集成用例跳过。隔离 Electron 完成中英文操作、选区定位、同一回复录入两张卡片和重新加载草稿。Chromium 复核跨消息拒绝、去重、换会话、字符上限和按原流程发送。回退范围为选区入口、草稿引用字段和词条。
- **开发过程 review**。复用消息操作测试与隔离 Electron 夹具，把选择范围、草稿恢复和发送正文串在同一流程，避免为样式另建应用测试入口。
- 文件说明批次 `selection-quote / 8eaf436 + 源码快照` 已核对。集中更新五份文件头，`npm run check:headers -- --files …` 通过。

## 2026-11-23 · 输入区上下文与缓存面板

- 模型选择旁显示可用窗口百分比。点击可查看 SDK 有效窗口、占用分类、压缩预留与最近一次模型请求的缓存计数。快照随运行持久化，完成后更新。[技术决策](../../../docs/decisions/2026-11-23-context-window-usage.md)
- `npm run check`、`npm test`、前端与桌面构建通过。395 项测试通过，1 项既有 WebFetch 用例跳过。隔离 Electron 用回环夹具验证 1280×800 中文和 1440×900 英文、60% 命中率、键盘与草稿、重开后读取。独立 SDK 探针验证手动压缩边界前后的摘要。[测试记录](../../../docs/claude-code-comparison.md) · [验收证据](../../../docs/evidence/agent-eval/2026-11-23-context-window-panel.json)
- 开发过程 review 先用一条真实 SDK 请求确认成功结果与关闭连接之间的可用窗口，再复用同一个夹具验证页面及 SQLite。调整点外点击时，以弹层实际覆盖范围选取视口坐标。

## 2026-11-23 · 前端设计系统与工作台改造

- 统一暖灰与橄榄绿的表面、状态与焦点语义。工作区、聊天、浏览器、检视器、设置、扩展和智能体迁移共享控件及 Lucide 图标。将旧的聊天与弹层样式迁到所属模块，移除无消费者的原型选择器。Motion 异步功能块用于连接与操作反馈，CSS 和 React 均响应减少动效。将 `check:ui` 接入常规检查。[设计规范](../../../frontend/DESIGN.md) · [技术决策](../../../docs/decisions/2026-11-23-frontend-design-system.md)
- `npm run check`、前端及桌面构建通过，398 项测试通过，既有 WebFetch 用例跳过。隔离 Electron 复核三种桌面视口、680px 导航抽屉、中英文、草稿、原生网页输入、分栏、叠层遮挡和恢复，以及日志分页下载。首屏 CSS gzip 从 18.92 降至 13.53 kB，JS 从 197.76 增至 207.97 kB，Motion 功能异步块为 18.90 kB。活动桌面切换待授权。[验收记录与复现](../../../docs/evidence/frontend-design-system/2026-11-23.md)
- **开发过程 review**。用同一隔离上下文夹具覆盖浏览器输入、布局、弹层、重开与截图。首次加载轨迹时焦点丢失，按同一通路收窄 Suspense 后复验。下次修改路由内容时，将首次异步加载的焦点断言与界面调整放在同一批次。
- 文件说明批次 `frontend-design-system / 当前源码哈希快照` 完成。按指定模型的只读建议复核，集中更新 22 份文件头。`npm run check:headers -- --files …` 覆盖本轮 76 份源码并通过。

## 2026-11-23 · 输入框上方的任务清单

- 当前运行的任务清单与输入框等宽，默认展开，支持键盘和鼠标折叠。完成数随运行快照更新，已完成的条目显示勾选和划线。运行结束后保留最终状态。进入下一轮后可在旧消息中展开对应清单。没有任务计划的当前运行隐藏输入框上方的清单。[实现说明与数据流](../../../docs/chat-task-plan.md)
- `npm run check`、`npm run build`、`npm run build:desktop` 通过。`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 通过 399 项，既有 WebFetch 用例跳过 1 项。任务交互断言位于 [消息操作回归](../../../frontend/src/features/chat/message-actions.test.ts)。隔离 Electron 45.4.1 通过本地回环模型和真实 SDK 的 `update_plan` 请求核对 `0/2` 至 `2/2` 的更新、折叠保持、历史查看与中英文。1280×800、1440×900、1920×1080 和 680×800 下检查清单宽度与输入框一致，本机截图在 `.local/task-plan-completed-zh.png`。回退范围为聊天渲染、样式和词条。
- **开发过程 review**。把切会话、折叠保持和新一轮历史归属加入现成的渲染回归，隔离桌面集中走一次真实工具更新。窗口调整后在同一个渲染帧读取清单和输入框边界，避免两次读取跨过窗口尺寸变化。
- 文件说明批次 `composer-task-plan / c1997a1 + 源码哈希快照` 已完成。核对建议与输入哈希后更新四份文件说明，`npm run check:headers` 的本次文件检查通过。本机输入清单位于 `.local/task-plan-headers.pKbLaq/input-sha256.txt`。

## 2026-11-23 · 工作台配色与对话流

- P0 统一品牌和选中色，修正 48px 顶栏、侧栏时间、待审批状态与本机信任提示。上下文显示剩余百分比及旧样本标记。P1 历史执行明细使用时间轴，补充失败计数、退出码和恢复进度。历史消息操作按需显现并保留键盘、复制反馈和触屏入口。回退范围为前端、词条和侧栏烟测断言。
- 类型、i18n、样式门禁和前端、桌面构建通过。404 项测试通过，1 项既有 WebFetch 用例跳过。Chromium 复核六主题与三种视口，隔离 Electron 复核原生分屏和执行明细。系统中文输入法实机测试待补。[验收记录与机器证据](../../../docs/evidence/frontend-design-system/2026-11-23-workspace-polish.md)
- **开发过程 review**。用同一合成 API 夹具核对主题、视口、权限和执行状态。用 `31b769f` 的隔离副本复现侧栏旧断言，再按按钮实际边缘修正。后续修改控件尺寸时直接测量相邻边界，并组合验证输入框初始高度和长文本封顶。

## 2026-11-23 · 实机验收后的输入区微调

- 24px 渐变覆盖聊天滚动区底缘，并让队列与新消息按钮显示在渐变上方。任务清单位于上下文和权限工具栏上方。短清单全部完成时自动收起，手动展开或收起的选择随当前运行保留。
- `npm run check`、`npm run build` 和文件说明门禁通过。全量测试 404 项通过，1 项既有 WebFetch 用例跳过。Chromium 的 [消息操作回归](../../../frontend/src/features/chat/message-actions.test.ts#L925) 检查渐变尺寸与点击穿透、清单顺序、从进行中到完成后的收起及键盘重开。`node --import tsx scripts/smoke-context-usage.mts` 首跑在关闭弹层后的即时焦点断言失败，原样复跑通过，覆盖原生分屏、输入和草稿。
- **开发过程 review**。把清单状态更新与渐变属性放进同一个现有浏览器用例，隔离桌面复用现有烟测验证原生层。

## 2026-11-23 · 前端类型与纯功能逻辑目录规范收敛

- 清理函数/闭包内部嵌套类型（`server/codex-model-catalog.ts`、`server/session-checkpoint.ts`），将散落全局声明（`Window`、`HistoryState`）集中至 `frontend/src/types/`。
- 建立统一纯功能工具目录：`frontend/src/utils/format.ts` 集中 `formatBytes`、`formatDate`、`formatDuration`、`formatSessionTime`，消除多处重复造轮子。
- 业务领域模型四件套收敛：从 `.tsx` 视图组件剥离纯功能函数与状态类型至对应的 `*-model.ts` 或 `*-utils.ts`（包括 `diff-model.ts`、`subagent-progress-model.ts`、`message-actions-model.ts`、`selection-quote-model.ts`、`spreadsheet-preview-utils.ts`、`file-preview-utils.ts`、`agent-model.ts`、`app/types.ts`），组件仅消费 props 呈现界面与分发回调。
- `npm run check`、`npm test`（404项通过，1项既有跳过）、`npm run build` 和 `npm run check:headers` 全量门禁通过。
- **开发过程 review**。通过静态扫描前置发现跨组件隐式契约依赖和重复工具实现，使用先建共享纯模块并保持原导出兼容路径的渐进迁移策略，一次性完成多领域组件瘦身并保持 100% 测试与类型安全。

## 2026-11-23 · 桌面窗口与浏览器面板收官

- Linux 和 Windows 默认隐藏原生菜单条，保留系统窗口框架和菜单。窗口持有当前主题的背景色。右侧浏览器将关闭操作并入 48px 标签栏，工具栏与语义状态条减高，变更记录改为贴右抽屉。工具摘要解码 HTTP(S) URL，紧凑回执和参数分别限高为 180px、120px。
- 类型、i18n、样式门禁和前端、桌面构建通过。408 项全量测试通过，1 项既有 WebFetch 用例跳过。隔离 Electron 核对 48px 顶栏对齐、标签切换和关闭、分隔条缩放、弹层遮挡与焦点恢复。Chromium 核对已完成清单首次挂载即收起。[验收记录与三栏截图](../../../docs/evidence/frontend-design-system/2026-11-23-desktop-final-round.md)
- **开发过程 review**。在一个现有 Electron 烟测中复用同一原生浏览器标签，验证抽屉、设置和上下文弹层。截图等待显示合成器完成全屏动画，再按隔离窗口几何裁取。弹层焦点测试按实际焦点恢复条件短时等待。

## 2026-11-23 · 移除输入区的全网搜索额度入口

- 移除全工具自动化模式旁的「全网搜索 Skill · 0 分」和额度弹窗，保留 `/` 调用 Skill、`#` 选择 MCP 和现有运行时费用校验。通过输入区发送继续采用 0 分默认额度。
- `npm run check`、前端与桌面构建通过。隔离 Chromium 的自动审批和消息操作回归 18 项通过，覆盖切换到全工具自动化后不再渲染搜索额度按钮。全量复跑通过 408 项，1 项既有 WebFetch 用例跳过。首跑的 Skill 子进程测试因临时测试文件 `state/ticks` 尚未生成失败，复跑通过。
- **开发过程 review**。在既有运行模式 Chromium 夹具补充断言，并复用现有发送与审批测试验证费用默认值。

## 2026-11-23 · 输入区权限按钮颜色

- 本机信任与全工具自动化的触发器文字、模式图标和下拉箭头共用主题警告前景色，背景和边框继续使用同组语义色。Rose 警告前景与浅底对比度为 4.88:1。
- Chromium 检查六套主题、四种运行模式的实际计算颜色，24 组通过。用 `.local/frontend-regression-20261123/mode-colors.mts` 可复跑实际页面夹具。`npm run check:ui` 与前端构建通过。

- 实机复查后调整全工具自动化触发器，改与菜单当前项的高亮共用主题强调底色和前景色。本机信任继续使用警告色。六主题、四种模式的 Chromium 回归通过，并直接比较了六主题全工具自动化触发器与展开菜单当前项的计算前景及底色。复跑夹具为 `.local/frontend-regression-20261123/mode-colors-accent.mts`。

## 2026-11-24 · Git 看板与开发会话 · 已验证

- 项目选择器和会话顶部均可打开 Git 看板。Node 运行时读取暂存、未暂存、未跟踪、冲突、分支占用及分页提交。独立开发会话可用当前工作树的 HEAD、本机分支或提交创建。显式原目录切分支检查工作区和待处理任务。并发和上下文引用按实际目录解析，历史分出的会话继承工作树。[使用说明](../../../README.md#git-看板与开发会话) · [技术决策与回退](../../../docs/decisions/2026-11-24-git-development-sessions.md)
- 最后一个关联会话归档才尝试回收。验证失败时保留目录。已验证的快照能还原 Git 索引、未暂存内容和未跟踪文件。真实本机 Git 加临时 SQLite 覆盖了 Git 归一化隐藏的字节差异、忽略文件、占用分支、缺失目录、受损快照、回收中断、v7 升级与跨数据根迁入。Linux bubblewrap 用例验证受控命令可以在 linked worktree 执行，且 Git 元数据被遮蔽。
- 基线 `0d3b184`，最终运行 `npm run check`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`、`npm run build`、`npm run build:desktop`。运行时 315 通过、1 个既有用例跳过，前端 115 通过。文件说明按源码哈希与单批只读建议核对，68 份源码头检查通过。
- Linux x64 Arch 工件 SHA-256 为 `e624dbb79be2044fc1a78dc9d06c2c90d79d93eb4c455f65be5571223b825301`。用实际工件解出的 Electron 45.4.1、Claude Agent SDK 0.3.326 和本地回环模型走通中英文创建、差异及提交浏览、按工作树补全文件、两个并行审批中的相对读取与同名文件写入、重开恢复和历史分支继承。验收入口为 `node --import tsx scripts/smoke-git-workbench.mts <Arch 包路径>`，本机工件、截图和原始日志位于 `.local/git-workbench-20261124/`。回环仅替代模型传输。
- 旧窗口正常退出后验证了 v7 SQLite 的可恢复副本。活动窗口随后使用当前源码的开发态重开，542 个 renderer 文件与已验收安装件逐个字节相同。保留原数据目录和 Chromium profile，本机网关健康检查返回 200。确认 2 个项目、12 个会话、119 条运行、9 个附件、12 个交付物与副本一致，6 个设置键值逐字节相同。当前 `.data` 与一处已绑定项目重叠，创建独立工作树需使用与所有项目检出分离的数据根。
- **开发过程 review**。先用本机 Git 对照索引和文件，再用同一个安装态夹具覆盖两个会话、审批和恢复，避免用替身的模型回答代替工具证据。审查用例促成了完整文件字节校验和实际分派前复核。工作台同期的 OpenWiki 任务已生成 Git 专页。下次应在第一次安装态验收中把截图布局和文件引用断言一起核对。

## 2026-11-24 · Git 差异侧栏与高亮

- Git 在桌面宽窗口打开右侧分栏，支持鼠标和键盘调宽。全窗口和侧栏共用同一内容实例，切换时保留工作树、文件和提交选择。窄窗口直接使用全窗口。关闭 Git 后恢复内置浏览器的原生标签。文件和提交差异展示原、新行号及增删统计，按语言加载语法高亮。[技术决策与回退](../../../docs/decisions/2026-11-24-git-diff-panel.md)
- 基线为 `0d3b184` 加工作区源码哈希。通过 `npm run check`、`npm test`、`npm run build`、`npm run build:desktop`。运行时 315 项通过、1 项既有 WebFetch 用例跳过，前端 118 项通过。文件说明单批只读核对 12 份输入，复核边界修正后 `npm run check:headers` 检查 12 份通过。
- Linux x64 Arch 安装件 SHA-256 为 `7b94cb6b805fa2701358ba5380d819b67be22451332849d2314f461cd35e23c8`。隔离 Electron 核对 1280×800、1440×900、1920×1080 和 1000×720，覆盖中英文、TypeScript 和 Markdown 高亮、增删行号、明暗配色、鼠标和键盘拖动、全窗口和焦点恢复。真实 WebContentsView 隐藏后恢复到原标签和地址。真实 SDK 与本地回环模型复验独立工作树和归档恢复。工件、截图、构建和安装烟测原始日志位于本机 `.local/git-diff-panel-20261124/`。
- 原窗口正常退出后用原数据目录和浏览器 profile 打开新版。542 个 renderer 文件与安装件逐项一致，运行时页面和本机网关均返回 200。保留 2 个项目、12 个会话、119 条运行、9 个附件和 12 个交付物，网关及工具设置字节一致。在线核对期间写入了工作区布局和位置，保留实时偏好。
- **开发过程 review**。在现有安装烟测集中验证分栏、原生浏览器和会话，再用相同布局复现极限拖动把 408px 导航压到 190px。修正右栏上限后确认导航和浏览器偏好稳定，并把极限拖动纳入既有烟测。下次在首轮安装验收直接验证默认宽度和用户已保存的宽布局。

## 2026-11-24 · Git 文件视图与 AI 提交

- 文件视图按暂存状态组织文件，显示类型图标、名称、目录、变动标记和语法高亮。选定工作树后可用 AI 起草暂存提交说明。用户核对清单，按需编辑标题和正文，再确认由本机 Git 提交。暂存或分支变化时重新核对，手写内容继续保留。[技术决策与回退](../../../docs/decisions/2026-11-24-ai-git-commit.md)
- 基线 `0d3b184` 加本次源码哈希。通过 `npm run check`、`npm test`、`npm run build`、`npm run build:desktop`。运行时 316 项、前端 118 项通过，1 项既有 WebFetch 用例跳过。单批文件说明整理后 `npm run check:headers` 检查 19 份通过。
- Linux x64 Arch 安装件 SHA-256 为 `32ef9fb05abd8cc758cd8cb56e069c48e073b1db799f6a07b16820c90701a9de`。真实 Electron、系统 Git 和回环模型验证中文生成、英文手填降级、旧暂存版本拒绝、编辑内容逐项落入提交、所选独立工作树作用域、未暂存内容保留和提交阶段的零模型请求。另用真实 Git 验证 SHA-256 首次提交、分离索引、改名与分离 HEAD。工件、截图和原始日志位于 `.local/ai-git-commit-20261124/`。
- 旧窗口正常退出后用原数据根和浏览器 profile 打开新版。545 个 renderer 文件与安装件逐项一致，运行时页面与本机网关均返回 200。核对 2 个项目、13 个会话、120 条运行、9 个附件、12 个交付物与 6 个设置记录。
- **开发过程 review**。API 回环夹具审计模型输入和确认次数，安装烟测再核对同一份草稿的实际编辑与 Git 结果。正文字段标签在有草稿时超时，使用最小 Chromium 页面确认嵌套标签混入了值，再验证分离后的标签。英文入口的点击验收用 Electron 实际内容尺寸，避免在超过原生窗口的模拟坐标上判断控件。

## 2026-11-25 · 文件变动滚动与逐文件暂存

- 文件行显示暂存与取消暂存按钮，快捷提交和 Amend 使用当前索引。取消新文件的暂存后，该文件回到未跟踪分组。文件列表用独立的细滚动条，提交区置于列表下方，窄侧栏增大文件区，储藏区默认折叠。[取舍与回退](../../../docs/decisions/2026-11-25-git-file-staging.md)
- 在隔离开发态 Electron 和真实 Git 中验证中英文操作及失效文件提示、无暂存时的快捷键保护、仅提交选中的文件，以及 1280×800、1440×900 和 450px 宽侧栏布局。真实 Git API 用例另覆盖字面路径、重命名、过期状态和首次提交前取消暂存。证据位于 `.local/git-file-staging-20261125/`。
- 正常退出旧桌面后从原数据目录和 Chromium profile 打开新构建。原工作区有效，新版首页与构建输出一致，本机网关健康检查通过，原数据库的 2 个项目、16 个会话、123 条运行和 7 条设置记录可读。
- **开发过程 review**。把滚动区高度、滚轮、提交区位置和 Git 索引结果放入同一套 Electron 夹具。全局继承的滚动条颜色覆盖了 Chromium 的尺寸样式，用窄侧栏截图定位后在文件列表内修正。下一次调整面板先检查各容器的计算样式，再跑窄宽和标准视口。
- 文件说明批次按本次验收源码哈希复核并集中更新，`npm run check:headers` 检查本轮 12 份文件通过。
- `npm run check`、`npm run build`、`npm run build:desktop` 和 `ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 已通过。测试为运行时 676 项、前端 119 项通过，1 项既有用例跳过。超大 diff 回归样本按当前 8,000 行上限修正。中间一次技能 broker 测试出现 `BrokenPipeError`，完整重跑通过，原始失败日志已保留。

## 2026-11-25 · Claude Agent SDK 补丁升级

- SDK 0.3.332 和配套 Claude Code 2.1.332 已落到项目依赖。同步三处真实 SDK 测试夹具的版本断言，保留 2.1.326 格式的历史分叉夹具。[版本依据与回退](../../../docs/decisions/2026-11-25-claude-agent-sdk-0332.md)
- 隔离候选通过类型检查、前端和桌面构建及全量测试。676 项运行时测试和 119 项前端测试通过，1 项既有跳过。Arch x64 安装件 SHA-256 为 `2961906183b680c6951a7ce8824806dad704aafbf5075f74076a0ebdf223a31a`。从实际安装件解包，用 Electron 和回环模型验证 2.1.332 启动、受控审批前文件保持原文、批准后的真实 MCP 写入和运行记账。
- 旧桌面正常退出后打开新版，沿用已有数据、Chromium profile 和本机网关。页面资源与验收构建一致，网关健康检查返回 200。在同一数据库核对了 3 个项目、19 个会话、124 条运行和 7 条设置。依赖扫描、隔离补丁批次和原始日志位于 `.local/dependency-upgrade-20261125/`。
- **开发过程 review**。用只更新测试版本断言前后的两次回归，明确区分测试固定版本和真实 SDK 行为。安装烟测首次用了默认本机信任模式，加入明确选择受控修改后重跑通过。下次在烟测发起请求前核对运行模式，直接记录 CLI 版本和审批轨迹。

## 2026-11-25 · 依赖维护和 PR 检查

- 在仓库添加每周 Renovate 扫描和 Linux x64 PR 检查。前端补丁可以成组提 PR，SDK、Electron、原生依赖和大版本先在 Dashboard 审批，PR 由维护者合并。文件预览、PDF、表格及 Markdown 渲染依赖由用户单独维护。[选型、验证和回退](../../../docs/decisions/2026-11-25-dependency-updates.md)
- 更新 TanStack Query 5.108.4、React 类型 19.3.1、i18next 27.2.8、React Resizable Panels 4.24.2 和 tailwind-merge 3.7.1。核对锁文件只有这五项及配套的 query-core 发生变化。Node 24.21.0 的干净安装通过类型检查、前端及桌面构建，运行时 676 项、前端 119 项通过，1 项既有跳过。隔离真实 Electron 核对了中英文交互、拖动侧栏以及暂存和提交。
- Renovate 44.262.1 仓库配置通过严格校验。提取试跑只识别两个预定清单，查询日志确认文件预览、PDF.js 和 Markdown 预览依赖被排除。工作流通过 actionlint，另外用 Ubuntu 24.04 用户态验证了安装动态加载器链接前后的真实 bubblewrap 探针。GitHub App 授权和首次远端工作流运行待完成。证据位于 .local/renovate-ci-20261125/。
- **开发过程 review**。先核对实际 lockfile 节点，再做干净安装，避免把缓存安装误当成 CI 证据。复用了隔离 Electron 入口，提前发现 npm ci 对 Electron 45 采用按需下载。下次配置 Linux runner 时先对照命令沙箱的动态加载器路径，再启用必过检查。

## 2026-11-26 · 本机信任会话的子代理插话

- 在前台子代理运行时，用 Ctrl+Enter 或队列的「立即插入」发送一条兼容消息。SDK 按调用标识将该批前台子代理转到后台，主会话先接收指令，随后接收各子任务报告。后台分支继续使用原有任务身份，支持单独停止。受控模式沿用原有审批和检查点。[技术决策和回退](../../../docs/decisions/2026-11-25-claude-subagent-insertion.md)
- 基线为 `f48da53`，候选源码按 SHA-256 复核。锁定 SDK 0.3.332 与 CLI 2.1.332 配合回环模型复现旧版将该插话标为停止后发送，验证新版在双分支未结束时送达指令，随后保持工具归属、收齐报告与清空队列。另验证停止一个后台分支、保留兄弟结果和拒绝不同会话或任务尝试的终态。
- `npm run check`、`npm test`、前端及桌面构建通过。运行时 685 项通过、1 项既有用例跳过，前端 121 项通过。真实 Electron 45.4.1 在隔离数据和 profile 中通过中文快捷键和英文队列操作验收，复跑入口为 `node --import tsx scripts/smoke-subagent-insertion.mts`。模型请求由本地回环替身响应。原始验证日志位于候选工作树的 `.local/subagent-insertion/`。
- **开发过程 review**。用同一个回环夹具把分支报告的释放时机固定在主会话应答之后，HTTP 回归和桌面验收复用该时序。桌面定位时直接选择外层任务的标题，区分嵌套的工具标题。清洁安装后先构建 Markdown 包再跑前端回归。
- 文件说明单批核对五份输入，按验证快照集中更新两份运行时说明。文件说明检查覆盖本轮五份源码。

## 2026-11-26 · GitHub Skill 完整包与本机登录

- 「扩展 → Skills → 从公开来源导入」支持公开仓库、目录和 `SKILL.md`，按选中提交保存正文、参考资源、二进制及执行位。同名候选显示路径并优先推荐 Claude 版。新安装默认手动，卡片支持自动调用和按目录摘要检查更新。原 GitHub 正文条目可保留身份和启用状态升级。[包格式、取舍与回退](../../../docs/decisions/2026-11-26-github-skill-packages.md)
- 可在导入窗口连接本机 GitHub CLI。应用仅保存账号名。CLI 核对已连接账号及仓库公开性，只读取安装所需的 GitHub API 元数据。固定提交的文件仍按 Git blob 哈希校验。[认证设计与回退](../../../docs/decisions/2026-11-26-github-public-import-auth.md)
- 真实 GitHub 验证单 Skill 仓库、Anthropic 仓库和 Impeccable。分别发现 1、20、27 项，Impeccable 的 Claude 版完整安装 63 个文件并保留脚本执行位。定向 HTTP 回归覆盖 ref 移动、附件变化、超限、损坏、下载中断、重试、同名与本地编辑冲突、项目隔离及旧版升级。
- Electron 45.4.1 在隔离数据根和 profile 中通过中文连接与导入、英文检查更新、会话可用性与跨项目隔离。锁定 Claude Agent SDK 0.3.332 配合回环模型，在只读会话中调用包内读取工具，并从独立工作树通过原生 Bash 执行真实 `scripts/impeccable context`。复跑入口为 `ATELIER_TEST_GITHUB_AUTH=1 node --import tsx scripts/smoke-github-skills.mts`，已登录的 GitHub CLI 用于验证线上传输。
- 旧窗口正常退出后，保留可恢复的数据库副本，沿用原数据根、Chromium profile 和本机网关启动新版。确认记录数量与 15 条现有设置一致，网关返回 200。Runtime 首页及 569 个 renderer 文件与已验收构建一致。连接与验证证据存放在 `.local/github-skills-evidence/`。
- **开发过程 review**。先用独立 HTTP 夹具定位来源和安装错误，随后复用一套 Electron 流程验证只读与本机信任调用。GitHub 匿名额度耗尽时记录响应头与中英文提示，认证后重跑同一路径。「到对话中使用」曾继承桌面的本机信任偏好，真实窗口发现草稿保存冲突后改为明确应用会话模式。下次先记录安装 HTTP 回执，再核对工作台导航和工具结果。
- `npm run check`、`npm run build`、`npm run build:desktop` 与 `ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 通过。最终工作区全量测试为运行时 787 项、前端 139 项通过，5 项既有用例跳过。
- 文件说明以 `e04b07d` 与验收源码哈希核对，单批集中补齐六份说明。文件头检查覆盖本轮 33 份源码。

## 2026-11-26 · GitHub Skill 仓库导入界面

- 将链接和查询放在同一行，仓库候选与预览并列，安装操作固定在弹窗底部。唯一可用项或唯一推荐版本会自动打开固定提交的预览。用户可以切换候选，预览完成后自行安装。输入更改后会清除旧预览。
- 加入 Chromium 回归，覆盖推荐版本、必须手动选择的仓库、旧预览清除，以及所选版本的提交参数。隔离 Electron 用 `pbakaus/impeccable.git` 验证了中文仓库查询、63 文件安装、英文检查更新、包内读取和独立工作树原生脚本。一次公网导入返回读取失败，重试同一固定来源后全链路通过。截图和日志位于 `.local/github-public-import-ui/`。
- 旧窗口正常退出后沿用原数据和浏览器 profile 启动新版。运行时返回与已验收构建一致的首页，原 GitHub 连接可读。文件说明单批核对五份输入，按验收哈希集中更新三份说明。
- `npm run check`、前端构建和全量测试通过。运行时 787 项、前端 140 项通过，5 项既有用例跳过。
- **开发过程 review**。用合成仓库响应快速复现结果页没有安装按钮的问题，再复用既有 Electron 验收覆盖真实 GitHub 查询和安装。下次同类改动先检查候选、选择和安装在同一弹层里的可见性。

## 2026-11-26 · 工作台下拉框统一

- 将项目、状态筛选、智能体编辑、扩展配置、检查器和 Git 历史中的 18 个原生下拉框改用现有 shadcn Select。弹层继承工作台主题，显示当前选择，支持键盘操作，保留「全部」、必填提示和禁用选项。
- `npm run check`、`npm run build`、`npm run build:desktop` 与 `ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 通过。运行时 786 项、前端 140 项通过，6 项跳过。隔离 Electron 核对了中英文项目切换、状态筛选、键盘焦点和弹窗选择。排序会话烟测通过新版下拉框打开了旧运行的事件记录。截图和日志位于 `.local/select-polish-evidence/`。
- 旧桌面正常退出后，沿用原数据根、浏览器 profile 和网关启动新版。运行时返回与已验收构建一致的首页，核对原有 3 个项目、18 个会话、158 条运行、10 条扩展与 16 条设置记录。文件说明单批核对本轮 17 份源码，按验收快照更新通用控件和测试说明，`npm run check:headers` 通过。
- **开发过程 review**。先用共享工具栏的 Chromium 夹具验证原生下拉框无法满足新交互，再在同一夹具中覆盖键盘、焦点、空值和必填行为。真实 Electron 验收只核对主题、页面切换和弹窗焦点，避免重复全量操作。

## 2026-11-26 · Git 面板实时同步

- 打开的 Git 面板监听正在查看的工作树、暂存区和共享引用。来自对话、其他会话和终端的写入触发读取，文件与差异按工作树隔离。分支变化时，已经打开的提交详情仍按原 SHA 显示。面板可见时每 15 秒校准一次。[设计和回退](../../../docs/decisions/2026-11-26-live-git-workbench.md)
- 基线 `909d3b8`。隔离工作树的 HTTP 测试验证同仓独立工作树、忽略目录、暂存区、共享引用及跨项目拒绝。`npm run check`、`npm run build`、`npm run build:desktop` 与全量测试通过，运行时 788 项、前端 140 项通过，5 项跳过。单批复核 12 份源文件并更新四处文件说明，`npm run check:headers` 通过。
- 真实 Electron 在开发态和解包的 Linux x64 Arch 安装件中通过验收。系统 Git 和锁定 Claude SDK 配合回环模型，在 Bash 和对话各自尚未结束时显示暂存差异及提交。外部连续修改同一文件时差异同步，查看旧提交时历史列表更新，切换英文并重开面板后文件计数仍自动更新。入口为 `node --import tsx scripts/smoke-git-live-sync.mts`。安装件 SHA-256 为 `81dbbf92163078e2b478570b31dee8b1ae90ee259bde50e8adf46f71a714d9c2`。原始日志和截图位于 `.local/git-live-evidence/`。
- 旧桌面正常退出后，沿用原数据根、浏览器 profile 和网关启动新版。首页与验收构建相符，网关健康检查返回 200。确认同一数据库的 3 个项目、18 个会话、159 条运行、10 条扩展和 16 条设置记录可读。
- **开发过程 review**。用两个独立的暂停点验证刷新与工具返回、对话结束解耦，用同一真实 Electron 夹具复跑安装件。一次并行重建被安装脚本的输入校验拒绝，待 renderer 构建完成后顺序重跑。下一轮在打包前冻结构建产物。

## 2026-11-26 · 长任务派发、插话回执和收尾

- 本机信任会话由锁定的 Claude SDK 0.3.332 / CLI 2.1.332 决定子任务的前后台运行。按 SDK 会话和输入 UUID 确认插话送达，报告汇总时继续开放输入，等原生空闲后收尾。启动或等待回执时保留排队消息。任务卡片显示每个分支最近的实际工具活动。[根因、选择与回退](../../../docs/decisions/2026-11-26-long-task-cli-parity.md)
- 基线为 `2218b97`。隔离回归在旧代码复现了默认后台被强制前台、回复后占槽、SDK 尚未就绪时展示立即插入，以及最后分支完成时提前关闭汇总期间插话。新版用真实 SDK 与本地回环模型验证了前后台派发、连续插话、停止前后确认、分支结果和实际收尾。通过 `npm run check`、`npm run build`、`npm run build:desktop` 与 `ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test`。运行时 793 项、前端 140 项通过，5 项跳过。单批复核 17 份源码，集中调整 8 份文件说明并通过 `npm run check:headers`。
- Linux x64 Arch 安装件 SHA-256 为 `da108199d1912e3d535d83266727a0f898f564e3a3ef3eeaf091e0d7cfa31751`。从实际安装件解包，在 1440×900 中文和 1280×800 英文 Electron 中验证了快捷键和队列入口、前台分支期间和报告汇总期间插话、队列送达回执、分支工具活动及两份最终报告。复测入口为 `node --import tsx scripts/smoke-subagent-insertion.mts [解包后的 atelier 可执行文件]`。
- 旧窗口正常退出并释放运行时后，用同一数据根、浏览器 profile 和本机 Shunt 启动已验收的解包版。对照 3 个项目、19 个会话、162 条运行、334 条消息及 16 条设置的记录标识，SQLite `quick_check` 返回 `ok`。可见窗口、运行时页面及网关健康检查通过。备份、安装态截图、红绿日志和切换回执位于 `.local/long-task-cli-parity-20261126/`。
- **开发过程 review**。直接用锁定 CLI 的回环输出区分输入回显、分支通知、父轮结果和空闲。复用同一夹具控制分支报告与汇总的释放时间，定位最后一个通知后的提前关槽。下次在第一次桌面验收同时检查 SDK 就绪和运行终态，直接用当前有序对话的状态定位器，减少因历史按钮改版造成的重跑。

## 2026-11-27 · 对话底部输入性能

- 在运行中会话输入草稿时，React 跳过参数未变化的历史区。引用和编辑在点击时读取最新草稿，回复、任务清单和消息操作状态随会话数据更新。改动位于前端渲染进程。[React memo 文档](https://react.dev/reference/react/memo)
- 同一个 60 条富文本历史的 Chromium 夹具中，14 次击键触发的历史区重渲染由 14 次降到 0 次。React Profiler 录得单次输入的 React 渲染耗时中位数从约 13.7 毫秒降到 2.4 毫秒。保留击键及后续回复更新的回归断言，原始性能采样位于 `.local/composer-performance/`。
- `npm run check`、`npm run build`、`npm run build:desktop` 和全量测试通过，运行时 796 项、前端 140 项通过，6 项跳过。隔离 Electron 45.4.1 使用回环模型和真实 SDK，在任务进行中验证中文组合输入、英文连续输入、草稿保存并重载、快捷插入和队列操作。
- 从原工作区重开开发版桌面，沿用原数据库、Chromium profile 和本机网关。确认窗口可见、网关健康、运行时提供已验收的前端构建，数据库完整性及记录数量一致。回退时恢复切换目录的 `previous-client` 并重开窗口。
- **开发过程 review**。用现有 Chromium 夹具同时验证性能与草稿操作，再用同一套回环任务验收双语桌面。以后把临时性能采样放在隔离工作树，避免与并行提交交叉。

### 输入框自动高度

- 支持 `field-sizing: content` 的浏览器直接按输入内容计算高度，旧浏览器保留 JavaScript 自动高度。输入区继续以 44–220 像素为高度范围，长草稿在输入框内滚动。[Chrome 表单自动尺寸说明](https://developer.chrome.com/docs/modern-web-guidance/guides/forms/form-fields-automatically-fit-contents)
- Chromium 的 14 次击键将应用同步读取输入框高度的次数从 14 降到 0。旧逻辑单次读取中位数约 0.2 毫秒。同一夹具通过了多行扩展、长文本溢出和删除后收缩，另外模拟旧浏览器验证了回退分支。原始日志位于 `.local/composer-autosize/`。
- 类型检查、前端与桌面构建及全量测试通过，运行时 796 项、前端 140 项通过，6 项跳过。隔离 Electron 用真实 SDK 和回环模型在运行中复核双语输入、自动高度、草稿恢复和发送。空闲后正常切换桌面，确认同一数据库、Chromium profile、本机网关和新样式资源。可从切换目录恢复 `previous-client`。
- **开发过程 review**。在隔离工作树采样并复用既有消息夹具，用同步几何读取次数做稳定断言。耗时仅存入采样日志，避免把机器负载波动当成回归。

### 草稿滚动条

- 长草稿使用 8 像素的主题色圆角滑块和透明轨道，隐藏上下箭头。输入框为滚动条预留宽度，长短草稿切换时正文宽度稳定。强制配色模式沿用浏览器滚动条外观。
- 隔离 Electron 在 1440×900 浅色和 1280×800 深色视口验证了短草稿、长草稿、拖动滑块、滚轮和键盘定位。截图与记录位于 `.local/composer-scrollbar/`。类型检查、构建和全量测试通过，运行时 796 项、前端 140 项通过，6 项跳过。
- 旧桌面空闲后正常切换。核对窗口、前端样式、网关、数据库、浏览器 profile 及各会话已保存草稿。回退时恢复切换目录的 `previous-client` 并重开窗口。
- **开发过程 review**。同一隔离窗口对比了系统样式、标准细条和最终实现。标准细条在 Linux Electron 仍保留箭头，直接复用 Git 面板的 Chromium 滚动条做法。用输入框实际宽度及滚动位置校验体验。[Chrome 滚动条样式](https://developer.chrome.com/docs/css-ui/scrollbar-styling)

## 2026-11-27 · Git 分支合并引用

- 切到 `main` 后，右键本地或远端跟踪分支，确认框显示具体合并方向。主进程按分支类型选择完整引用，执行前核对工作树当前分支。无变更时显示目标已经包含来源提交。[取舍和回退](../../../docs/decisions/2026-11-25-git-history-and-branch-workbench.md#合并分支的引用和结果)
- 旧版 Electron 在同名引用夹具中提示成功而 `main` 保持原提交。新版在中英文窗口完成同样操作并核对实际目标 SHA、已包含提示和目标变化后的拦截。独立克隆复现了本机的 `909d3b8`、`5656dea`、`8f2f607` 三个引用，原路径返回引用歧义及已更新，新路径使克隆中的 `main` 快进到 `8f2f607`。记录在 `.local/git-merge-ref/`。
- `npm run check`、`npm run build`、`npm run build:desktop`、文件说明检查和全量测试通过。运行时 797 项、前端 140 项通过，6 项跳过。回归覆盖引用碰撞、无变更、失效目标、缺失来源及冲突中止和继续。
- **开发过程 review**。通过本机引用和 reflog 先确认实际切换方向，再用隔离副本复现。用最终分支 SHA 作为验收条件，同时检查提示、工作树目标及历史刷新。

## 2026-11-26 · 可配置工作台快捷操作

- 基于最新 `main@909d3b8`，分支 `feat/workbench-shortcuts`。保持现有布局，新增 `Mod+;` 会话切换、`Mod+Shift+;` 快捷导航，以及左右栏、相邻会话、Git/终端/浏览器和输入聚焦。设置提供逐项录制、导航键、停用、恢复默认和持久化。用户字母输入仅在浮层作用域内解释。[决策与边界](../../../docs/decisions/2026-11-26-workbench-shortcuts.md)
- 快捷模块通过语义动作和可用性接入工作台；共享 schema/matcher、SQLite 设置仓储、Query、renderer 与桌面桥接保持独立。右栏使用已有 React Activity 隐藏并保留状态，恢复终端复用同一个实例；输入焦点请求绑定会话与实际 composer 生命周期。
- 核心/HTTP/SQLite/会话测试 7 项通过；真实 Electron 原生桥接 2 项、renderer 7 项通过；实际 client 与 RuntimeSupervisor 的完整交互 10 个场景通过，0 个页面异常和 0 次模型请求。四组类型检查、架构、Query、i18n、UI 语义及前端/桌面构建通过。源码说明按 43 份哈希的单批只读建议集中维护。
- 全量检查已执行并保留失败证据：tsx CLI 和生产桌面单实例锁受 Unix socket `EPERM` 限制，使用相同 Node loader 与隔离测试宿主验收；15 项既有前端用例无法启动缺失的 Chromium。全量运行时的短超时及迁移取消经独立复跑 83 项全部通过；detached shell 回收失败在未修改的 `909d3b8` 基线中复现。没有修改架构门禁、生产启动保护或无关进程回收功能。[验收详情及复跑命令](../../../docs/evidence/workbench-shortcuts/verification.md)
- 独立审查修复了全窗口 Git 遮住会话切换结果、选择器取消时焦点丢失、持按键泄漏及 IME Escape 误关闭，未留下 Critical/Important 项。IME 修复有真实 Electron 合成事件的独立红绿对照；未声称实体键盘、系统热键和真实输入法候选窗口已验收。
- **开发过程 review**。先固定共享配置与动作接口，再按持久化、renderer、原生边界分工，减少并行冲突。最终用同一个真实工作台脚本覆盖状态和焦点。环境阻碍分别做最小复现，不为通过测试改动生产保护；全量测试的挂起应及早增加有界诊断，避免重复等待。测试专用桌面组合入口归入 fixtures，保持生产导入边界。

## 2026-11-27 · 快捷操作合入最新 main

- 合并 `main@7d40474` 与 `feat/compact-workbench-layout@7e7467b`，保留主干 8 个后续提交。快捷设置适配到 `server/http/settings/`，组合入口只增加仓储注入；会话输入保留窄订阅、稳定回调、getDraft 与 Conversation memo，再加入快捷聚焦请求。
- 核心/HTTP/会话回归 10 项、原生桥接 2 项、快捷 renderer 7 项、原有消息与输入性能测试 5 项通过。实际 Electron 工作台 11 场景通过，新增验证 Git 隐藏期间和恢复后的实时更新，以及连续键入后快捷切会话保留草稿。四组类型与架构、Query、i18n、UI 检查及前端/桌面构建通过。
- 全量诊断保留既有失败：运行时 742 项中 719 通过、1 项既有进程回收失败、2 项迁移取消、20 跳过；迁移不强制退出时独立 74 项通过。前端 15 项因 Chromium 缺失无法启动，本次关键消息回归以原断言在真实 Electron 通过。tsx CLI 的 Unix socket 受限，等价脚本使用 Node loader。没有声称全量测试全绿，详见[本轮验收](../../../docs/evidence/workbench-shortcuts/main-integration-2026-11-27.md)。
- 独立源码审查没有阻塞项，7 份适配源码按哈希完成一次说明复核。**开发过程 review**：按真实冲突分工，只改领域路由和焦点接入；保留主干性能断言，以目标 Electron 引擎验证关键路径；对全量超时和环境失败做有界诊断，避免修改无关产品行为来适应测试环境。

## 2026-11-27 · 队列续跑与授权复核

- 上一轮收尾后按顺序派发待处理消息。仅新增自动 Skill 时，已经排队的消息沿用入队时的范围。授权范围有实际变化时，队首提供「复核并继续」，确认后保留原消息、附件和运行偏好。展开时只显示一次正文。[决策和回退](../../../docs/decisions/2026-11-27-queued-followup-scope.md)
- 基于 `34f9d34`。只读复算了打开问题时数据库中的两份授权指纹，确认原有七项 Skill 一致，新增两个自动继承项触发了旧版拒绝。临时 SQLite 的失败用例验证了旧版停止派发。新版在真实 SDK 和回环模型的 Electron 中验证了自动新轮次、已有 Skill 变化停住、取消确认和保留附件的单次发送。中英文窗口展开消息各只显示一份正文。
- 类型检查和前端、桌面构建通过。运行时 806 项通过、7 项跳过。基础分支的前端全量首次失败于工作台快捷设置测试替身缺少读取路由，结合工作区已存在的替身修正后复测为 147 项通过、1 项跳过。原始日志与截图位于 `.local/queue-followup/`。
- 待旧桌面空闲后切换，当前会话切换样式随启动前的构建一起保留。确认窗口、网关、SQLite、浏览器 profile 和已保存队列哈希一致，原队首的三张图片仍在。文件说明按 18 个输入哈希做单批复核，集中更新 12 项并通过说明检查。
- **开发过程 review**。先根据事件元数据复算原授权，定位具体变化，再复用同一个队列测试验证正反路径。部署前重建现有工作区的首页，验证原构建已包含的会话切换改动不会被覆盖。

## 2026-11-27 · 项目级 OpenWiki MCP 适配

- 新增仓库内 stdio 启动器，可在现有项目 MCP 表单显式登记，不自动加载 MCP 配置、不更改逐次审批。仅转发六个同步工具；连接重建后必须先确认持久记录和上游恢复回执的运行 ID 都匹配，再转发一次调用。不修改真实 Wiki。[设计和回退](../../../docs/decisions/2026-11-27-atelier-openwiki-mcp.md)
- 适配及项目扩展测试共 9 项通过；主项目与工具 TypeScript 检查、文件说明、格式以及前端生产构建通过。`npm run check` 被沙箱未挂载 `.claude/rules/technical-decisions.md` 阻断。限时全量运行时测试报告 772 通过、9 失败、2 取消、7 跳过，后续前端全量未完成；失败包括 SDK 进程退出和并行任务超时，未将其判定为已复现的基线问题。
- **开发过程 review**。将“能发现工具”与“找得到同一个活动运行”分开验收；用替身调用轨迹核实恢复和无重放。真实桌面与本机 OpenWiki 的连续调用仍需登记后验收，不能用替身代替。

## 2026-11-27 · 本地 MCP 跨项目手动选用

- 原项目可以显式共享已测试、已授权的本地 MCP。其他项目在普通会话的 `#` 候选中手选，不自动挂载、不获得配置管理权；调用仍逐次人工审批，常驻进程按实际项目和工作目录隔离。[设计与回退](../../../docs/decisions/2026-11-27-shared-project-mcp.md)
- 运行时定向测试 12 项、前端定向测试 21 项通过，覆盖双项目 HTTP 发送、撤回共享、人工审批、进程隔离和选择器缓存。四组 TypeScript 检查、查询边界、i18n、UI 语义、文件头以及前端和桌面构建通过。`npm run check` 仍受沙箱缺少 `.claude/rules/technical-decisions.md` 阻断。限时全量测试报告运行时 777 通过、9 失败、2 取消、7 跳过，前端全量未完成。未切换正在运行的桌面实例，也未对真实项目执行 Wiki 同步。
- **开发过程 review**。管理目录与选择目录分开测试；用真实消息提交接口验证共享条目如何交给目标项目运行器，并用独立进程计数器验证隔离，避免把选项出现在界面上当作执行通过。

## 2026-11-28 · 终端复制与粘贴

- Linux 终端聚焦时使用 `Ctrl+Shift+C` 复制选区、`Ctrl+Shift+V` 粘贴系统剪贴板纯文本。前端通过 xterm 的按键处理和 `paste` 入口完成操作。粘贴内容返回后复核终端连接、视图租约和焦点，避免在切换终端后向旧 shell 写入。回退时移除终端的剪贴板按键处理。[xterm API](https://xtermjs.org/docs/api/terminal/classes/terminal/)
- 旧版隔离 Electron 确认复制快捷键无法改写系统剪贴板。新版以 `node --import tsx scripts/smoke-terminal.mts --clipboard` 在隔离 X11 显示上验证中英文界面的复制、Unicode 粘贴、回车前无执行、`Ctrl+C` 中断实际 shell 和刷新后恢复。当前 Wayland 工作台已刷新并读取新版资源，Electron、运行时和原终端进程的 PID 均一致。证据在 `.local/terminal-clipboard/`。
- `npm run check`、前端及桌面构建通过。前端回归 184 项通过、1 项跳过。全量运行时测试 927 项通过、6 项跳过，HTTP 路径拒绝用例单独复跑仍返回 400，断言预期为 403。终端完整冒烟在修改前后均出现 12,000 行输出用例超时。本次文件头按两份源码哈希集中核对。
- **开发过程 review**。以系统剪贴板内容和 shell 写出的文件作为断言。单独运行剪贴板场景，避免长输出场景的波动遮住复制、粘贴的验证。前端可热加载时先验证恢复，再刷新正在使用的窗口。

## 2026-11-28 · 首条消息提交时创建会话

- 「新建会话」、项目选择和「使用 Skill」打开项目草稿。重复点击复用文字、上下文和已选选项。未发送附件留在当前窗口内存，发送时才上传。首发使用固定会话编号并沿用消息幂等键，已确认后进入正式会话。手选模型和运行偏好随草稿进入正式会话。[取舍与回退](../../../docs/decisions/2026-11-28-new-conversation-draft.md)
- 旧版隔离 Electron 连点四次请求创建四条记录。新版以真实运行时、锁定 SDK 和回环模型验证 1440×900 中文和 1280×800 英文界面。覆盖跨项目与刷新恢复、无首发时零会话、附件暂存、创建及首发回执被丢弃后的重试，以及只落一条用户消息。验证首发后持久化手选模型。终端剪贴板回归在独立 X11 显示上通过。
- `npm run check`、前端和桌面构建、28 份文件说明检查通过。全量测试的三处失败在干净基线复现，分别为 HTTP 拒绝状态码、消息间距和右栏宽度。证据位于 `.local/new-conversation/`。
- 工作台正常退出并释放数据锁后沿用相同 SQLite、端口和浏览器 profile 打开新版。切换前后 4 个项目、28 个会话、548 条消息、268 条运行和 16 条设置记录的计数一致。等现有任务结束后刷新前端，确认窗口加载最终资源、运行时 PID 保持一致、内置网关健康检查返回 200。
- **开发过程 review**。用实际创建请求数快速复现，再复用同一隔离窗口模仿丢失回执并检查运行时的真实计数。需要已保存会话的工具测试显式建立夹具，可独立验证工具行为。

## 2026-12-08 · 开发桌面在 Git 拉取后重建

- `npm run desktop` 观察当前工作树提交，在 `git pull` 或切分支更新检出后串行重建前端和 Electron。仅执行 `git fetch` 不触发。构建失败保留窗口，下一次检出更新可再次重建。手动入口为 `npm run desktop:build`。[取舍与回退](../../../docs/decisions/2026-12-08-desktop-git-rebuild.md)
- 临时 Git 仓库测试覆盖首次启动、拉取、失败恢复、参数透传及退出。隔离 X11 中启动真实 Electron 和运行时，从本地远端拉取后确认主进程构建产物更新、新首页写入、旧资源可读、原窗口持续存活并正常退出。证据位于 `.local/desktop-git-rebuild/`。
- 类型检查、文件说明、前端和桌面构建通过。运行时测试 928 项通过、6 项跳过，HTTP 拒绝状态码仍与既有断言不符。前端测试 182 项通过、1 项跳过，消息间距和右栏宽度仍与既有断言不符。
- **开发过程 review**。用两个本地仓库代替远端服务，分别用可控替身强制构建失败，用实际窗口验证资源兼容与退出。界面标题断言以窗口实际加载的初始标题为基准，避免和本地化标题实现耦合。
