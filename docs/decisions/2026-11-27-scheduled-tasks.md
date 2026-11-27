# 定时任务与自动化调度架构决策

## 1. 问题与范围

基于 `main@d57d571` 在分支 `feat/scheduled-tasks` 设计 Atelier 的定时任务（Scheduled Tasks）能力。目标是让用户既能在界面中管理周期/一次性自动化任务，也能在会话里让 Agent 通过内置工具创建、修改、暂停或立即执行定时任务，并完整复用 Atelier 现有的会话、运行、权限审批、工作树与通知体系。

### 现有模块与边界约束

- **运行时与存储**：Node 24 运行时通过 `acquireDataOwner` 独占 `ATELIER_DATA_DIR`，SQLite（`better-sqlite3` + Drizzle ORM，当前 `LATEST_SCHEMA_VERSION = 11`）遵循唯一写者原则；运行时进程由 Electron `RuntimeSupervisor` 托管（`desktop/main.mts`、`server/main.ts`、`server/app.ts`）。
- **运行触发与并发**：`createRun`（`server/modules/runs/create-run.ts`）通过 `run_receipts` 实现幂等，通过 `createExecutionSlots`（`server/modules/runs/execution-slots.ts`）限制全局最多 3 个活动运行并校验重叠目录与工作树锁；同会话忙时进入 `MessageQueue`（`server/modules/message-queue/scheduler.ts`）。
- **权限与安全**：`PermissionService`（`server/permissions.ts`）负责逐次审批与 `approvalMode: 'automatic'`（仅 `mode === 'edit'` 且非重试允许，详见 [桌面任务自动化](2026-11-20-task-automation.md)），并支持 `requireManual: true` 强制人工确认与 `maxSearchChargeFen` 计费上限。
- **扩展工具与前端**：内置工具通过 `buildRunMcpTools`（`server/modules/runs/mcp-tools/index.ts`）以 `mcp__atelier__*` 暴露给 Claude Agent SDK；前端服务端状态强制走 TanStack Query（`check:query` 零豁免），右侧工具面板遵守 [工作台面板接入](../panel-development.md)，界面文案需中英文双语（`check:i18n`）。

### 本期范围与非目标

- **纳入范围**：宿主级（Host-wide）持久化定时任务、单定时器调度器、Misfire（错失触发）与重叠防重、内置 MCP 工具、全局 `/schedules` 视图、对话内任务卡片与右侧详情面板、运行历史与通知策略、Electron 休眠唤醒同步与可选托盘驻留。
- **首期非目标**：不引入外部队列中间件（Redis/BullMQ）、不在首期支持分布式多机调度、不注册 OS 级 `systemd --user` / `launchd` 脱离应用的独立守护进程（留作 V2 演进）、不引入第三方不受信插件脚本作为任务执行器。

## 2. 查阅来源

以下来源均明确区分「读过源码/官方文档」「观察截图」与「未运行验证」：

1. **DeepSeek Harness（DSH）Host-wide Schedule**：
   - 官方子系统文档：[deepseek-ai/deepseek-harness `docs/subsystems/schedule.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/schedule.md)（读过完整设计文档与 Cordis API 签名，未运行 DSH）。
   - 用户提供的 DSH 桌面端实际界面截图（`image_dc6738.jpg`、`image_dc673b.png`）：核对了对话内自然语言创建、内嵌任务卡片、右侧「规则 / 任务运行记录」双 Tab 详情面板、暂停/立即执行/删除交互，以及会话内可折叠「自动化任务」触发消息。
   - 社区生态参考：[weibaohui/dsh-plugin-scheduled-items](https://github.com/weibaohui/dsh-plugin-scheduled-items)（基于 `croner` 的全页管理与新会话执行）与 [ylxmf2005/dsh-scheduled](https://github.com/ylxmf2005/dsh-scheduled)（跨项目全局定时任务设计），仅读过 README 摘要。
2. **Claude Code / Claude Desktop 生产问题反馈**：
   - [anthropics/claude-code#43645](https://github.com/anthropics/claude-code/issues/43645)：周期任务每次新建顶级会话导致数日内产生数百条垃圾会话污染侧栏。
   - [anthropics/claude-code#54517](https://github.com/anthropics/claude-code/issues/54517)：用户需要在定时运行结束后直接像普通会话一样追问与纠偏，深层级钻取入口摩擦过大。
   - [anthropics/claude-code#107966](https://github.com/anthropics/claude-code/issues/107966)：修改已暂停任务的调度规则时被静默重新启用的缺陷。
3. **轻量 AI Cron 守护进程与响应协议**：
   - [t0dorakis/murmur](https://github.com/t0dorakis/murmur)：读过 README 中的 `HEARTBEAT.md` 静默/告警响应协议（`HEARTBEAT_OK` 静默记日志 vs `ATTENTION:` 触发提醒）。
4. **Cron 计算库与 Electron 官方 API**：
   - [Hexagon/croner](https://github.com/Hexagon/croner)（MIT，零依赖，TypeScript 原生，支持 IANA 时区、Vixie Cron 语义、DST 跳变/重叠处理、ISO 8601 一次性时间与 `nextRun()` 纯计算，v11.x 在 Node 24 下活跃维护）。
   - [harrisiirak/cron-parser](https://github.com/harrisiirak/cron-parser)（MIT，v5.10.x，仅解析与迭代，无内置单次时间/轻量表达式整合）。
   - [Electron `powerMonitor`](https://electronjs.org/docs/latest/api/power-monitor) 及已知缺陷 [electron/electron#42050](https://github.com/electron/electron/issues/42050)（Linux 部分环境未触发 `suspend`/`resume`）、[electron/electron#44252](https://github.com/electron/electron/issues/44252)（`resume` 可能重复触发两次）。
5. **本仓源码**：`server/app.ts`、`server/db/connection.ts`、`server/db/schema/git-worktrees.ts`、`server/modules/runs/create-run.ts`、`server/modules/runs/execution-slots.ts`、`server/modules/runs/mcp-tools/index.ts`、`server/modules/message-queue/scheduler.ts`、`server/modules/sessions/lifecycle.ts`、`server/permissions.ts`、`server/http/events/routes.ts`、`desktop/main.mts`、`desktop/host/ui-notifications.mts`、`frontend/src/app/sidebar.tsx`、`frontend/src/app/panels/registry.ts`、`frontend/src/app/workspace-router.tsx`。

## 3. 候选方案对比

### 3.1 调度引擎与进程归属

| 维度 | 方案 A：独立 OS 守护进程（`systemd --user` / `cron`） | 方案 B：DSH 模式（宿主内单定时器，双存储写入） | 方案 C（推荐）：Node 运行时内单定时器 + 同库事务 + Electron 唤醒辅助 |
| :--- | :--- | :--- | :--- |
| **SQLite 唯一写者** | 破坏 `acquireDataOwner` 独占锁，需另建跨进程 RPC | 需维护 Session 与 Schedule 两个持久化域，存在崩溃重复投递窗口 | **完全保持单一 SQLite 写者**，借 `run_receipts` 幂等键消除重复投递 |
| **休眠 / 关闭后恢复** | 熄屏后由系统唤醒，但需处理打包安装、权限与卸载清理 | 依赖宿主存活，重启时按 latest-only 合并补跑 | 运行时启动 + `powerMonitor.on('resume')` + 60s 时钟漂移兜底；Electron 提供可选「关闭最小化到托盘」 |
| **Linux x64 交付成本** | 高（影响打包、升级、卸装与沙箱测试） | 中 | **低**，不改变现有 `RuntimeSupervisor` 进程模型，V2 可平滑外接 `systemd --user` |

### 3.2 定时表达式与依赖选择

| 维度 | 自研解析器 | `cron-parser`（v5） | `croner`（v11，推荐） |
| :--- | :--- | :--- | :--- |
| **功能覆盖** | 易在夏令时（DST）跳变、闰年、Vixie DOM/DOW 语义上踩坑 | 仅支持 Cron 迭代，需另写 `once`/`interval` | 原生支持 5 段 Cron + IANA 时区 + Vixie DST 语义 + `nextRun()` 纯计算，零传递依赖 |
| **许可证与维护** | 无外部许可 | MIT，维护良好 | **MIT，零依赖**，Node 24 与浏览器同构（前端可直接预览未来 N 次触发时间） |
| **是否引入 RRULE** | — | — | **首期不引入 `rrule`**；95% 场景由 `once` / `interval` / `daily` / `weekly` / `cron` 覆盖，避免 RFC 5545 边界复杂度 |

### 3.3 执行落点（Target Mode）策略

| 策略 | 借鉴来源 | 优点 | 风险与 Atelier 缓解措施 |
| :--- | :--- | :--- | :--- |
| `session`（复用指定会话） | DSH 截图与文档 | 保留连续上下文，适合在当前任务流里追问 | 长跑导致上下文膨胀；需明确提示并支持切换目标 |
| `new_once`（**默认**：预留并复用专属自动化会话） | DSH `schedule.md` | 既不污染用户开发会话，又避免 `claude-code#43645` 的垃圾会话爆炸，同时支持单点追问（`claude-code#54517`） | 长期运行上下文仍会增长；提供「手动重置会话 / 达到轮次上限后自动归档并轮换」选项 |
| `new`（每次触发新建独立会话） | DSH `schedule.md` / `dsh-plugin-scheduled-items` | 每次运行上下文干净、token 稳定 | 需强制最小触发间隔（默认 ≥ 5 分钟）并标记会话 `origin: 'schedule'`，侧栏默认折叠归组且支持按保留条数自动归档 |

## 4. 结论与架构设计

### 4.1 核心决策清单

1. **宿主级调度器归属 Node 运行时**：新增 `server/modules/schedules/`，由 `server/app.ts` 装配并在关停序列中统一释放定时器与在途触发。不新增独立守护进程。
2. **引入 `croner`（锁定精确版本）负责 Cron 与时区计算**：仅使用其纯计算能力（`new Cron(expr, { timezone, paused: true }).nextRun(after)`），**不把任务定时器托管给库内部多 timer**，仍由 `ScheduleScheduler` 维护单一最近触发 timer + 60s 时钟漂移自检，避免长休眠后 `setTimeout` 漂移及 Linux `powerMonitor` 漏报（`electron#42050`）。
3. **五种权威调度类型（不转译）**：`once`（RFC 3339 UTC 或本地时间+时区）、`interval`（最小 60 秒，保留锚点）、`daily`（`HH:mm` + IANA 时区）、`weekly`（`HH:mm` + ISO 星期集合 1–7 + IANA 时区）、`cron`（标准 5 段 + IANA 时区）。所有存储的 `next_run_at` 均为 RFC 3339 UTC；仅编辑名称、提示词或通知策略时**不重算锚点**；编辑已暂停任务时**严禁静默恢复**（规避 `claude-code#107966`）。
4. **复用 `createRun` 与同库幂等**：每次触发以 `schedule:${taskId}:${scheduledForIso}` 作为 `idempotencyKey` 调用 `createRun`（手动「立即执行」使用 `schedule:${taskId}:manual:${uuid}` 且不改变 `next_run_at`）。`scheduled_task_runs` 与 `scheduled_tasks.next_run_at` 推进在同库事务内收敛，消除跨存储重复投递。
5. **无人值守安全与成本护栏（强于 DSH）**：
   - 任务显式配置 `mode`（默认 `ask` 只读；可选 `edit`）、`approvalMode`（`manual` | `automatic`，仅 `edit` 可选 `automatic`）、`maxSearchChargeFen`（默认 `0`）、`timeoutMs`（单次运行超时保护）与可选 `agentRevisionId`。
   - **关键安全约束**：当 Agent 通过 MCP 工具创建定时任务，或修改任务以提升权限（启用 `edit + automatic`、提高 `maxSearchChargeFen`、修改高权限任务的 `prompt`）时，工具执行必须经 `PermissionService` 并设置 `requireManual: true` 人工确认，防止提示词注入静默植入高权限定时后门。
6. **并发公平与重叠保护**：
   - 复用 `createExecutionSlots`（全局上限 3 并发），**为交互式会话预留至少 1 个执行槽**：定时任务仅在当前全局活动运行数 `< 2` 时启动；若遇到 `SERVER_BUSY`、`RUN_ACTIVE` 或 `GIT_DIRECTORY_BUSY`，根据任务 `overlapPolicy`（`skip` 默认 / `queue` 入 `MessageQueue` / `defer` 延迟重试一次）处理，不计入失败次数。
   - **Misfire 策略**：任务配置 `misfirePolicy`（`run_once` 默认：休眠/关闭期间漏掉多次仅合并补跑最近一次，随后推进到下一个未来时刻；`skip`：直接跳过过期时刻）。
   - **连续失败熔断**：`consecutive_failures >= 5` 时自动将任务置为 `paused` 并发送告警通知，避免故障循环消耗额度。
7. **生命周期联动与级联规则**：
   - 归档或删除项目时，外键级联删除其 `scheduled_tasks`。
   - 归档目标会话（`target_mode === 'session'` 或已绑定 `new_once`）时，自动暂停关联定时任务并记录暂停原因（`target_archived`），恢复会话不自动恢复任务，需用户显式确认；删除会话时将 `target_session_id` 置空并暂停任务，历史记录保留 `target_session_id` 快照。
   - **乐观并发控制**：更新接口支持 `expectedUpdatedAt`，防止前端表单与 Agent MCP 工具并发编辑互相覆盖（冲突返回 `409 SCHEDULE_CONFLICT`）。

### 4.2 数据模型与迁移（Schema v12）

在 `server/db/schema/schedules.ts` 定义两张 Drizzle 表，新增 `server/db/migrations/0012-scheduled-tasks.sql` 与 `apply-scheduled-tasks.ts`，在 `server/db/connection.ts` 将 `LATEST_SCHEMA_VERSION` 升级至 `12`：

```sql
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_mode TEXT NOT NULL,            -- 'session' | 'new_once' | 'new'
  target_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  agent_revision_id TEXT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  timing_kind TEXT NOT NULL,            -- 'once' | 'interval' | 'daily' | 'weekly' | 'cron'
  timing_json TEXT NOT NULL,            -- 权威调度配置 JSON
  time_zone TEXT NOT NULL,              -- IANA 时区，如 'Asia/Shanghai'
  mode TEXT NOT NULL,                   -- 'ask' | 'edit'
  approval_mode TEXT,                   -- NULL | 'automatic'
  max_search_charge_fen INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER,
  misfire_policy TEXT NOT NULL DEFAULT 'run_once', -- 'run_once' | 'skip'
  overlap_policy TEXT NOT NULL DEFAULT 'skip',     -- 'skip' | 'queue'
  notify_policy TEXT NOT NULL DEFAULT 'on_error',  -- 'always' | 'on_error' | 'on_attention' | 'never'
  status TEXT NOT NULL DEFAULT 'active',           -- 'active' | 'paused' | 'ended'
  pause_reason TEXT,
  next_run_at TEXT,                     -- RFC 3339 UTC；paused/ended 可为空或保留锚点
  last_run_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,             -- 'user' | 'agent'
  created_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_scheduled_tasks_due ON scheduled_tasks(status, next_run_at);
CREATE INDEX idx_scheduled_tasks_project ON scheduled_tasks(project_id, updated_at DESC);

CREATE TABLE scheduled_task_runs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  trigger_kind TEXT NOT NULL,           -- 'scheduled' | 'manual' | 'misfire'
  scheduled_for TEXT NOT NULL,          -- RFC 3339 UTC
  target_session_id TEXT,               -- 不可变快照
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  prompt_snapshot TEXT NOT NULL,        -- 不可变提示词快照
  status TEXT NOT NULL,                 -- 'dispatched' | 'completed' | 'failed' | 'skipped'
  skip_reason TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE UNIQUE INDEX idx_scheduled_task_runs_idempotency
  ON scheduled_task_runs(task_id, trigger_kind, scheduled_for)
  WHERE trigger_kind IN ('scheduled', 'misfire');
CREATE INDEX idx_scheduled_task_runs_history
  ON scheduled_task_runs(task_id, created_at DESC);
```

- **历史裁剪**：单任务默认保留最近 200 条 `scheduled_task_runs`（在写入新记录的同一事务内裁剪），避免长期高频任务膨胀数据库。
- **`Run` 与 `Session` 扩展**：`Run` 增加可选字段 `scheduleMeta?: { taskId: string; taskName: string; triggerKind: 'scheduled' | 'manual' | 'misfire'; scheduledFor: string }`；`Session` 增加可选字段 `origin?: 'schedule'`（旧版读取安全忽略）。

### 4.3 模块边界、API 与前端接入

| 层 | 路径 | 职责与约束 |
| :--- | :--- | :--- |
| **共享契约** | `shared/schedules.ts`、`shared/i18n/catalogs/schedules.ts` | Zod schema、类型推导、错误码（`SCHEDULE_CONFLICT` / `SCHEDULE_INVALID_TIMING` / `SCHEDULE_TARGET_ARCHIVED`）及中英文词条 |
| **数据仓储** | `server/db/schema/schedules.ts`、`server/db/repositories/schedules.ts` | Drizzle 表与事务查询，不直接引入 HTTP 或运行协调器 |
| **领域服务与调度器** | `server/modules/schedules/timing.ts`、`service.ts`、`scheduler.ts` | 时间计算（封装 `croner`）、CRUD + 乐观锁、单定时器与 misfire/overlap 协调；触发时仅调用注入的 `createRun` 与 `createSession` |
| **内置 MCP 工具** | `server/modules/runs/mcp-tools/schedule-tools.ts` | 暴露 `create_scheduled_task`、`list_scheduled_tasks`、`update_scheduled_task`、`delete_scheduled_task`；高权限创建/提权走 `PermissionService({ requireManual: true })` |
| **HTTP & SSE** | `server/http/schedules/routes.ts` | `GET/POST /api/schedules`、`GET/PATCH/DELETE /api/schedules/:id`、`POST /api/schedules/:id/run`、`GET /api/schedules/:id/runs`；经 `/api/events` 推送 `schedule.updated`、`schedule.run.updated` |
| **前端查询层** | `frontend/src/use-query/schedules/` | 按操作拆分独立 TanStack Query hook，订阅 SSE 事件失效缓存，遵守 `check:query` |
| **前端 UI** | `frontend/src/features/schedules/`、`sidebar.tsx`、`panels/registry.ts`、`conversation-turn-parts.tsx` | 1) 左侧栏新增 `/schedules` 全局管理页；2) 注册右侧受控面板 `atelier.schedule`（复用 `PanelHost` + `PanelLayoutButtons`），承载「规则 / 运行记录」双 Tab；3) 对话内渲染任务创建卡片（点击「打开」呼出右侧面板）与可折叠「自动化任务」触发头 |
| **桌面宿主** | `desktop/main.mts`、`desktop/host/runtime.mts` | 监听 `powerMonitor.on('resume')` 通过受控 IPC 通知运行时执行一次幂等 `tick()`；Phase 3 增加可选托盘驻留开关与通知偏好联动 |

### 4.4 分期实施计划

- **Phase 1（后端闭环 + 全局管理页）**：Schema v12、引入 `croner`、`ScheduleService` + `ScheduleScheduler`、复用 `createRun`、HTTP/SSE 路由、`/schedules` 列表与新建/编辑/暂停/立即执行/运行记录。
- **Phase 2（对话内联动，对齐 DSH 体验）**：内置 MCP 工具 + 高权限人工审批、对话内任务卡片、右侧 `atelier.schedule` 详情面板、会话内可折叠「自动化任务」触发头。
- **Phase 3（桌面后台体验与去噪通知）**：Electron `powerMonitor` 唤醒通知 + 可选关闭最小化到托盘 + `on_attention` / `on_error` 桌面通知（复用 `DesktopUiNotificationsPreferences`）。

## 5. 验证计划与回退条件

### 验证计划

1. **静态与边界检查**：运行 `npm run check`（覆盖 `check:architecture`、`check:query`、`check:i18n`、`check:ui`、前后端及桌面端 TypeScript 严格检查）与 `npm run format:check`。
2. **单元测试（隔离临时 SQLite + 注入假时钟）**：
   - `timing.ts`：覆盖 5 种调度类型、IANA 时区夏令时春季跳空与秋季重叠、闰年、无效 Cron 拒绝、编辑非时间字段不移动锚点。
   - `scheduler.ts`：覆盖 `misfirePolicy`（`run_once` 合并补跑 vs `skip`）、`overlapPolicy`（`skip` / `queue`）、交互槽预留（活动运行 = 2 时延迟）、同 `scheduledFor` 幂等防重、连续失败 5 次自动暂停、编辑已暂停任务保持 `paused`。
   - `schedule-tools.ts`：覆盖只读任务自动创建 vs `edit + automatic` 强制触发 `PermissionService` 人工确认；验证 `expectedUpdatedAt` 乐观锁冲突返回 `409`。
   - 生命周期联测：验证会话归档/删除后关联定时任务自动暂停且历史快照不丢失。
3. **集成与真实桌面验收**：
   - 使用隔离项目与回环替身 runner 端到端验证「创建 -> 到点触发 -> SSE 刷新 -> 手动立即执行 -> 暂停 -> 删除」。
   - 在真实 Linux x64 Electron 窗口验证：左侧 `/schedules` 入口、对话内卡片点击打开右侧面板、面板收起/全屏/与原生 Browser 遮挡兼容、中英文切换文案、以及窗口最小化托盘与唤醒补跑。

### 回退条件与策略

- **数据兼容**：迁移 12 仅新增独立表（`scheduled_tasks`、`scheduled_task_runs`），`Run` 与 `Session` 新增字段均为可选，不破坏既有表结构。若上线前需回退，移除路由、调度器初始化、MCP 工具注册、前端导航与 `atelier.schedule` 面板注册即可，旧版应用可忽略新增表继续正常读写。
- **阻断门槛**：若出现以下任一情况，不得进入发布验收：1) 同一计划时刻发生重复触发或绕过幂等；2) Agent 可未经人工确认直接创建或提权为 `edit + automatic` 定时任务；3) 应用退出时调度定时器或子运行未能随 `app.close()` 干净释放导致进程滞留。
