# atelier 工程约定

本文件是项目级 Agent 规则的唯一入口，适用于主会话、子代理及人工协作。先读[桌面路线图](openspec/roadmaps/build-atelier-desktop/roadmap.md)和[当前阶段日志](openspec/roadmaps/build-atelier-desktop/task-log.md)。以用户要求的桌面体验、数据可靠性和可验证行为判断复用还是重写。当前优先开发与验收 Linux x64 功能。Windows 和 macOS 各完成一轮候选构建，后续平台验收与发行按用户安排推进。UI 优先中、大尺寸 PC，默认复用 shadcn/ui，内容以清楚的层级、舒展的宽度和克制的留白呈现。

## DSH Bash 输出

- 查 Git 概览（状态、日志、变更统计）时优先显式使用 `rtk git …`；若 `rtk` 不在 `PATH`，用可执行的 `"$HOME/.local/bin/rtk"`。未安装、需要完整输出或机器可读格式时，直接用 Git。沿用 Bash 审批，不启用改写 Hook。

## 编辑前

1. 重要技术决策遵循[调研与决策规则](.claude/rules/technical-decisions.md)。先查官方资料并读可对比的成熟项目源码，写入 `docs/decisions/` 的取舍、依据及验证计划，再开始实现。没有合适方案时记录检索范围和自研理由。
2. 说明本轮用户能执行的操作、改动涉及的进程、验收方法。核对现有工作区改动，仅提交已验证且属于本任务的内容。
3. 打开目标目录对应的规则。Claude Code 通过 `.claude/rules/` 的 `paths` 按文件匹配。其他 Agent 和子代理根据下表读取。跨层变更同时遵循所有命中的规则。

| 改动 | 先读 |
|---|---|
| React 页面、组件、样式、前端库 | [前端](.claude/rules/frontend.md) |
| 控件、表单、弹窗、业务组件、响应式和无障碍交互 | [组件 UI](.claude/rules/component-ui.md) 和 [shadcn 官方 Skill](.claude/skills/shadcn/SKILL.md)（[固定来源](https://github.com/shadcn-ui/ui/tree/f50887ae68d0fdcbfbe86b57be08af94a4c88a68/skills/shadcn)） |
| Electron main、preload、原生网页、IPC、发行与安装态验收 | [桌面端](.claude/rules/desktop.md) 和 [Electron Skill](.claude/skills/atelier-electron/SKILL.md) |
| API、SDK、运行时、序列化契约、前端 API 客户端 | [API](.claude/rules/api.md) |
| SQLite、ORM、查询、事务、迁移及数据访问边界 | [数据库规则](.claude/rules/database.md) 和 [ORM 架构决策](docs/decisions/2026-11-21-orm-architecture.md) |
| 应用状态、会话、草稿、查询、SSE、取消与恢复 | [状态管理](.claude/rules/state.md) |
| 用户功能、工具与权限、前端 feature、可复用包 | [功能模块](.claude/rules/features.md) |

## 语言与质量门槛

- 产品和发行工具的可执行源码使用严格 TypeScript。React 使用 `.tsx`，模块按运行时选 `.ts`、`.mts`、`.cts`。发行目录里的 `.js`、`.mjs`、`.cjs` 由构建生成。平台规定的清单、桌面入口、样式及 PKGBUILD 使用各自格式。
- 桌面、打包和安装态测试都纳入 `npm run check`，开启 `strict` 和 `noUncheckedIndexedAccess`。新边界从 `unknown` 解析，JSON、IPC、模型工具参数和子进程消息均做运行时校验。核心契约从一份 schema 推导。类型断言只用于已经收窄且可说明的事实。禁止用 `any`、`@ts-nocheck`、无依据的 `!` 或关闭编译选项使检查变绿。
- 新功能的应用自有界面文案使用类型化 i18n 词条，同一改动补齐简体中文和英文，覆盖可见提示、无障碍名称和原生对话框。`npm run check` 会运行 `check:i18n`。验收受影响的交互时，在两种语言下核对操作提示和错误状态，特别检查由服务端数据或第三方控件决定的文案。具体规则见[前端](.claude/rules/frontend.md)和[桌面端](.claude/rules/desktop.md)。
- React 服务端状态统一走 TanStack Query（`scripts/query-legacy.json` 已清零，不得新增豁免）。按 API 操作在 `frontend/src/use-query/<领域>/` 建立独立 hook，复杂交互编排归同域业务 hook，组件消费数据与动作。
- 把一次用户操作追到真正拥有状态的层。跨边界传 ID 和数据，不传框架对象、任意频道或未验证路径。废弃实现随经过验证的替代一起清理。
- 局部高频状态（浏览器 Tab/URL、表单编辑态、局部弹窗与筛选）就近留在消费面板或子控制器内，不挂回 `Workspace` 等顶层外壳；传给 `memo` 子树的回调与派生对象保持引用稳定，交互信号（如输入框聚焦）只保留单一权威通道，乐观或本地覆盖态在确认后显式释放。
- 遵循无环与职责分层：共享类型独立放 `types.ts`（子模块禁止反向导入同目录 `index.ts`），不在同域保留重复协调器，遵守 `scripts/check-import-boundaries.mts` 的循环检查与热点文件行数上限；桌面 IPC 复用 `desktop/host/trusted-ipc.mts` 并在组合入口显式绑定，Git 持久状态与 Worktree 变更走安全原子 I/O 与租约包装，高吞吐流式通道明确背压水位。
- Agent 执行行为以 Claude CLI 与项目锁定的原生 Claude Agent SDK 为对齐基准，包括同批前台子代理的调度。任何偏离原生行为的限制或语义变更，都必须先向用户说明差异并获得明确确认；不得自行决定，也不得从已有例外推定后续偏离已获授权。
- 使用隔离项目和临时数据根测试，桌面测试另隔离 `userData`。实施结束运行 `npm run check`、`npm test`、`npm run build`。桌面改动从真实 Electron 窗口验证，发行改动从实际安装件验证。报告明确区分替身、真实 SDK、实际模型和系统包测试，有失败则留下复现步骤。

## 工作台右侧工具

- Git、终端、浏览器以及后续右侧工具统一由工作区管理收起、全屏和拖拽。标题栏使用终端同款按钮；收起不退出路由、不销毁业务资源，从同一入口或切换右栏快捷键恢复。关闭单个标签是独立操作。
- 全屏占满工作区而非系统桌面；使用统一停靠阈值、宽度范围及分隔条，不在业务面板内另设一套。接入和验收见[工作台面板接入](docs/panel-development.md)。

## 性能优化

- 以用户报告的实际操作、数据规模和并发负载建立基线，选定端到端指标和验收条件。交互卡顿在代表性的负载下测操作到界面反馈的延迟，包含长尾。涉及流式界面时，覆盖持续输出期间的交互。
- 沿实际路径采样，同一轮处理对验收指标有实质影响且已证实的瓶颈。替代路径验收后一并清理旧实现、重复工作和临时探针。有兼容要求的分支要注明适用条件并验证。
- 用相同场景和负载复测。若仍能复现用户可感知的问题，继续定位剩余瓶颈，直到达到验收标准或遇到明确阻塞。交付时给出前后指标和真实场景的验收结果，遇到阻塞时写清剩余影响和验证缺口。

## 开发过程 review

每个完整功能验收后，按[开发过程 review](.claude/rules/development-process-review.md)在执行日志记录一次简短反思，写清可减少的重复任务、验证和排查，以及下一轮怎样调整。

## 文件维护

每个完整功能通过验收后，只派发一批后台文件说明整理，指定 `gpt-6.1-terra`、`xhigh`。开发与交付可继续。主会话按版本核对建议，只在职责或实现发生变化时集中更新文件头，再运行独立检查 `npm run check:headers`。具体触发、去重、冲突与失败处理见[文件维护规则](.claude/rules/file-maintenance.md)。

## 归属、权限和交接

- Electron main 管窗口、系统交互和网页视图，运行时管 SDK、授权、审批与持久化。SQLite 和不可变交付物各有唯一写者。网页使用按项目隔离的受限分区。人工接管期间，模型暂停网页操作与观察，交还后重新观察。
- 文件与工具实际执行前复核授权。受控修改逐次确认。用户为会话选择全工具自动化后，后续任务通过统一审批服务自动裁决已获授权的工具，并逐次记录操作轨迹。登录在网页进行，凭据由本机安全配置提供。付费模型、签名、推送和发布沿用用户授权。
- 桌面更新验收通过后，直接切换用户正在使用的桌面实例。正常退出旧窗口，等待运行时写盘并释放数据锁，再沿用同一 `ATELIER_DATA_DIR`、浏览器 profile 和本机网关配置打开新版。确认项目、会话和设置仍可读取，再报告切换完成。涉及数据格式升级时先保留可恢复的副本。
- 主会话负责取舍、跨模块契约、最终验收与 Git。委派需说明范围、负责人、交付物与证据，并按全局规则选模型。调查、创作、审查 brief 加入「禁止执行任何 git 命令（不 commit、不建分支、不 add），git 由主会话按项目规则统一安排。」
- 阶段结束时更新执行日志及对应说明。架构决策影响进程边界、控制权、数据根或发布承诺时，在同一变更中记录决策和回退路径。历史证据留在 `docs/evidence/`，`prototype/` 保留作为设计参考。

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

Use the repository's documented maintenance process to refresh generated pages after source changes. Check its configuration and completed runs before relying on automatic updates. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
