# C5 · 后端 Git 安全 I/O 与状态机收口、前端多提交瘦身

## 问题与范围

1. `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`、`nlink === 1n`、前后 `stat`/`lstat` inode/mtime/ctime/size TOCTOU 校验、`sameInode`/`statIdentity`、`readHeadTarget` 与 `checkDirectories` 在 `commit-journal.ts`、`commit-plan-snapshot.ts`、`commit-plan-execution.ts` 与 `commit-plan-recovery.ts` 之间重复了 4 份。
2. `CommitPlanRecoveryCoordinator` 在 `commit-plan-coordinator.ts` 与 `commit-plan-recovery.ts` 中重名定义，合法 1 步状态跃迁边（`ahead` vs `legalEdge`）各硬编码了一份。
3. `DevelopmentWorktrees`（927 行）混杂路径租约/终端占用计数与 Git 操作编排，且 `create`/`reclaim`/`restore` 重复同一套双重检查幂等重放骨架。
4. 前端 `GitMultiCommitEditorMessages` 声明 70+ 文案字段迫使 `git-multi-commit-dialog.tsx` 维护 130 行纯 `t('multi.*')` 透传；组上限 `120` 散落前后端；`useGitMultiCommitReview` 混杂模型偏好选择、5 个互斥 ref/state 及 4 处重复 `GIT_PLAN_STALE` 处理；`GitMultiCommitEditor` 单文件 1,115 行；`git-views.tsx` 保留无收益的 `GitHistoryView` 浅封装。

不改变 HTTP/SSE 契约、多提交恢复不变量、错误码与界面交互语义。

## 取舍

- 抽深模块 `server/modules/git/git-safe-io.ts` 集中 `OPEN_REGULAR_READ_FLAGS`、`OPEN_DIRECTORY_FLAGS`、`errnoIs`、`sameInode`、`statIdentity`、`readRegularFileSafely`、`readHeadTarget` 与 `verifyCheckoutDirectories`；各调用点保留原有精确错误码映射。
- `isLegalJournalAdvance` 归口 `commit-journal.ts`；删除 `commit-plan-coordinator.ts` 中重复的 `CommitPlanRecoveryCoordinator` 定义（改导入 `commit-plan-recovery.ts` 并导出现实协调器接口 `CommitPlanCoordinator`）。
- 从 `development-worktrees.ts` 抽离 `WorktreeLeaseManager`（含 `directoriesOverlap` 重导出兼容），并用 `runIdempotentWorktreeOp` 收敛 `create`/`reclaim`/`restore` 三处双重检查幂等重放。
- `MAX_MULTI_COMMIT_GROUPS = 120` 提升至 `shared/git-multi-commit.ts`；删除 `GitMultiCommitEditorMessages`，编辑器及拆出的左/右/底三栏（`git-multi-commit-group-list.tsx`、`git-multi-commit-inventory.tsx`、`git-multi-commit-footer.tsx`）直调 `useUiTranslation('git')`；`useGitMultiCommitReview` 拆出 `useGitMultiCommitModelSelection`，以单一 `busyPhase` + `runExclusive` 与 `handlePlanError` 取代互斥 ref；`GitHistoryView` 默认自挂 `GitQueryFeedback` 并删除 `git-views.tsx` 浅封装。

## 验证与回退

新增 `tests/git-safe-io-and-leases.test.ts`（符号链接/硬链接/超限安全读、状态机 4 条合法跃迁与非法边拒绝、`WorktreeLeaseManager` 目录重叠与终端预留回收），再运行 `npm run check`、`check:headers`、`build`、`build:desktop`、Git 定向套件、完整 `npm test` 及隔离 Wayland 真实 Electron 烟测（`smoke-git-workbench.mts`、`smoke-right-tool-panels.mts`）。无数据迁移，回退为单次 commit revert。
