# Git 分支侧栏重构、提交历史无限滚动与多维检索

## 问题与范围

Git 工作区「分支与提交」面板原先依赖手动点击「加载更多提交」按钮，左侧分支列表视觉层级平铺、长 Worktree 路径截断占行，且缺乏分支与提交历史的检索/过滤能力。
需要将提交列表改造为触底自动加载、重构左侧分支栏信息层级，并实现分支实时过滤与提交历史多维检索（关键词、作者、时间范围），同时保持鼠尾草绿主题一致性、无缝支持暗色模式，并遵循 React 最佳实践与单一职责模块拆分。[Git 差异面板决策](2026-11-24-git-diff-panel.md)

## 查阅与取舍

- **无限加载与分页机制**：采用 W3C 原生 `IntersectionObserver` 监听位于提交列表底部的 1px 透明哨兵元素，配置 `rootMargin: '0px 0px 240px 0px'`（约 4~5 条提交高度预拉取）。维护 `isLoadingMoreRef` 与 `hasNextPage` 双锁，避免快速滚动或网络慢时触发重复并发请求。底部提供骨架屏（Skeleton）、初始提交细线分割（已加载完毕）以及点击重试条（加载失败）。
- **检索与过滤双重保障**：
  - **左侧分支**：采用纯前端 0 延迟即时模糊匹配，输入词条时自动展开包含命中项的分组，高亮命中字符；无命中时展示空状态提示。
  - **右侧提交**：采用「前端即时防御过滤 + 250ms 防抖后端 `git log` 聚合检索」。输入瞬间通过客户端 `visibleCommits` 滤除不匹配项，彻底杜绝网络滞后期的列表闪烁；防抖后将 `query`、`author`、`since` 透传至后端，利用 Git 的 `--grep`、`--author`、`--since` 及 `rev-parse --disambiguate` 完成提交说明、短/长 Hash 与作者的完整历史深度检索。
- **视觉层级重构**：
  - 固定工作树 HEAD 状态卡片：顶部展示检出状态、呼吸动画指示点及短 SHA。
  - 可折叠分组与角标：本地分支与远端跟踪分支支持独立折叠，附带数量角标。
  - 选中与检出标识：选中分支左侧添加 3px 深绿 Accent Bar；当前检出分支添加微型 `HEAD` 标签。
  - 紧凑 Worktree 胶囊：将长路径转换为文件夹图标加末级目录名的圆角胶囊，Hover 时通过原生 Tooltip 展示完整绝对路径。
  - 远端前缀弱化：将 `origin/` 等前缀弱化显示，突出分支本身名称。
- **架构解耦与 React 最佳实践**：
  - 将大组件拆分至 `frontend/src/features/git/git-history/`：提取 `useGitCommitFilters` 隔离状态与防抖副作用，抽取 `GitHeadCard`、`GitBranchGroup`、`GitBranchItem`、`GitCommitRow`、`GitCommitSkeleton` 等纯展示子组件并使用 `React.memo` 避免长列表重绘。
  - 后端在 `server/modules/git/git-reader.ts` 抽取 `queryGitLogCommits` 统一处理 NUL 分割日志解析与容错，复用时间区间转换与校验。

## 验证与回退

- **自动化测试**：
  - `npm run check`（包含架构边界、Query、i18n、UI 语义、严格 TypeScript 编译）通过。
  - `npm run check:headers` 对新增及修改源码通过。
  - `tests/git-workbench.test.ts`（11/11 项）全部通过。
  - `npm run test:frontend`（119/119 项）及 `npm test` 全量套件通过。
- **安装态与桌面验证**：
  - `npm run build && npm run build:desktop` 构建通过。
  - Electron 桌面实例平滑切换，验证即时过滤、无限滚动加载、分支折叠与短 Hash 复制功能正常。
- **回退方案**：若出现滚动异常或检索不兼容，回退 `git-history` 目录及 `server/modules/git/git-reader.ts`，历史与工作树底层数据结构保持向下兼容，无需迁移数据库。

## 合并分支的引用和结果

本地分支 `remotes/origin/feat/compact-workbench-layout` 和远端跟踪引用 `refs/remotes/origin/feat/compact-workbench-layout` 都能匹配同一个简称。旧桌面在隔离 Electron 中切到 `main`、右键本地功能分支并确认合并，界面提示成功，但 `main` 保持原提交。Git 会优先匹配 `refs/<简称>`，该远端提交已是 `main` 的祖先。[Git 引用解析](https://git-scm.com/docs/gitrevisions)

确认弹窗显示来源与目标，IPC 传工作树路径、来源的分支类型和名称，以及确认时的目标分支。主进程按类型构造完整引用并验证存在，执行前检查该工作树的当前分支。沿用 Git 原生合并和冲突处理。GitHub Desktop 使用 `--` 分隔引用并区分 `Already up to date.` 与实际合并，本项目沿用这两点，在已固定 C locale 的执行服务中返回结构化结果。[Git 合并](https://git-scm.com/docs/git-merge) · [GitHub Desktop 合并实现](https://github.com/desktop/desktop/blob/5c566a49a3c3612c490a1c6f0f90edb3686c57c6/app/src/lib/git/merge.ts)

在独立仓库复测本地与远端名称碰撞、无变更合并、目标在确认后切换和现有冲突中止流程。回退需同时恢复 renderer、preload、主进程的合并契约。Git 数据格式保持原有版本。
