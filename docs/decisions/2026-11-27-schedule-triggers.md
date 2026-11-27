# 自动化任务统一触发与远程遥控架构决策

## 1. 问题与背景

在 [定时任务与自动化调度架构决策](2026-11-27-scheduled-tasks.md) 中，Atelier 已具备基于单定时器与同库事务的定时任务能力（Schema v12、`ScheduleService`、`ScheduleScheduler`、`POST /api/schedules/:id/run` 与 4 个管理类 MCP 工具）。

随着自动化任务投入实际使用，出现了三类高频扩展诉求：
1. **跨会话复用剧本**：用户在任意交互式会话中，希望用自然语言直接拉起某个已配置好的自动化任务，并传入当次临时上下文（如 PR 编号、分支名或排查线索）。
2. **任务间编排联动**：上游定时巡检任务发现异常时，能够按需触发下游修复或汇总任务，同时避免无限循环互相唤醒。
3. **本地脚本与未来远程遥控**：能够通过本机脚本、Git Hook、手机快捷指令、IM 机器人或内网穿透/隧道安全地远程启动指定任务，而无需把 Atelier 的整个本地管理 API 暴露给外部。

如果为每种场景各自增加一套独立表结构、触发逻辑或专用接入协议，系统会迅速变得碎片化、难以维护。本文明确**统一触发架构、正交原语、能力边界与防过度设计红线**。

## 2. 架构原则与能力边界

### 2.1 三层解耦与单一执行漏斗

将自动化系统严格拆分为三层，彼此通过稳定契约交互：

1. **任务本体层（`ScheduleService` + `shared/schedules.ts`）**：
   - 保持单一任务模型，不拆分为「定时任务 / 手动任务 / Webhook 任务」多套实体。
   - **触发方式与时钟正交**：在 `timing` 中增加 `kind: 'manual'`（无时钟，纯按需触发）。同一个任务既可以是纯定时、纯按需，也可以「平时定时跑 + 随时被外部触发」。
   - 增加可选稳定别名 `slug`（项目内唯一，小写字母/数字/连字符，如 `daily-sync`、`release-check`），让会话、脚本与远程调用不再依赖 UUID。
2. **统一触发漏斗（`ScheduleScheduler.trigger`）**：
   - 所有触发源（内部时钟、补跑、UI 手动试跑、Agent MCP、本地 API、远程 Trigger 端点）**全部汇入唯一的 `scheduler.trigger(target, request)`**，严禁旁路直接调用 `createRun`。
   - 统一收敛五项治理能力（只实现一次，所有场景自动继承）：
     1. **寻址与状态门禁**：支持 `id` 或 `slug`（`projectId` 作用域内优先解析，全局兜底唯一匹配）；任务处于 `paused` 时外部/Agent 触发默认拒绝（`SCHEDULE_PAUSED`），仅 UI 手动试跑可显式传 `allowPaused: true`。
     2. **临时上下文注入（`input`）**：支持最长 8,000 字符的临时补充上下文，运行时以固定分隔块拼接到当次 `promptSnapshot` 末尾，**不修改原任务 `prompt` 模板**。
     3. **统一幂等去重（`idempotencyKey`）**：时钟触发沿用 `(taskId, triggerKind, scheduledFor)`；外部/Agent/Webhook 触发支持 `idempotencyKey`（HTTP 支持 `Idempotency-Key` 请求头或 Body 字段），重复投递直接返回既有运行记录并标记 `deduplicated: true`。
     4. **并发公平与重叠策略**：统一遵循任务的 `overlapPolicy`（`skip` / `queue`）与 `SCHEDULE_CONCURRENCY_CAP = 2`（为交互式用户保留至少 1 个执行槽；`manual` 显式试跑与既有行为一致）。
     5. **链路追踪与防死循环（`causation`）**：通过 `Run.scheduleMeta` 传递 `chainDepth` 与 `visitedTaskIds`，默认限制最大触发深度为 `3`（`SCHEDULE_MAX_CHAIN_DEPTH = 3`），且严禁自触发与环路触发（目标任务已在 `visitedTaskIds` 中直接拒绝）。
3. **薄适配层（Thin Adapters）**：
   - **会话 / 任务联动（MCP）**：新增 `trigger_scheduled_task` 与 `get_scheduled_task_run`，自动从当前 `run` 提取 `sessionId`、`run.scheduleMeta.chainDepth` 与 `visitedTaskIds` 转调 `scheduler.trigger`。
   - **UI 与本机脚本**：增强 `POST /api/schedules/:idOrSlug/run`，支持可选 `{ input?, idempotencyKey?, allowPaused? }`。
   - **远程遥控窄口（Webhook / Trigger Token）**：新增独立路由 `POST /api/triggers/schedules/:idOrSlug`，仅校验该任务专属的 `Authorization: Bearer <token>`（常数时间哈希比对）与基础内存限流，随后转调 `scheduler.trigger`。

### 2.2 明确的非目标（防过度设计红线）

- **不做可视化 DAG / 工作流引擎**：不引入节点连线图或 YAML 编排 DSL。上游任务是否触发下游任务、传递什么上下文，由 Agent 在执行时直接调用 `trigger_scheduled_task` 决策。
- **不做同步阻塞等待**：所有触发接口一律异步立即返回 `{ run, deduplicated }`，调用方按需查询 `get_scheduled_task_run` 或依赖既有通知机制，防止长连接或上游会话阻塞。
- **不把第三方 IM / 隧道协议耦合进调度核心**：飞书、Telegram、微信、iOS 快捷指令、GitHub Webhook、Tailscale、Cloudflare Tunnel 均作为外部转发层，统一调用标准 HTTP `POST /api/triggers/schedules/:idOrSlug`。
- **严格禁止触发时提权**：任何外部或 Agent 触发只能提供 `input` 和 `idempotencyKey`，**不能**覆盖任务的 `mode`、`approvalMode` 或 `maxSearchChargeFen`。远程触发默认关闭，必须由用户在工作台显式开启并生成单任务 Token；Agent 通过 MCP 触发具有 `edit + automatic` 无人值守写权限的任务时，若调用方并非已获批的自动链路，仍遵循显式权限策略。

## 3. 场景组合矩阵

少量正交原语即可覆盖全部目标场景，无需为单个场景引入专有功能：

| 场景 | 组合原语 | 触发入口 | 核心护栏 |
| :--- | :--- | :--- | :--- |
| 日常定时巡检 | `timing = daily/weekly/cron/interval` | 内部单定时器 | Misfire 合并、重叠跳过、连续失败熔断 |
| 会话中复用剧本 | `timing = manual` + `slug` + `input` | MCP `trigger_scheduled_task` | 不污染原模板、异步返回 `runId` |
| 多任务串联接力 | 上游定时任务 + 下游 `slug` + `input` | MCP `trigger_scheduled_task` | `chainDepth <= 3`、禁止自触发与环路 |
| 本地脚本 / Git Hook | `slug` + `idempotencyKey` | `POST /api/schedules/:idOrSlug/run` | 本机 CSRF + 幂等去重 |
| 手机 / IM 远程遥控 | `slug` + 单任务 `Trigger Token` + `input` | `POST /api/triggers/schedules/:idOrSlug` | 最小权限窄口、单任务独立可吊销 Token、限流、禁止跨站浏览器 CSRF |

## 4. 数据模型增量（Schema v13）

在既有 v12 表上做最小增量迁移（`0013-schedule-triggers.sql` + `apply-schedule-triggers.ts`，`LATEST_SCHEMA_VERSION = 13`）：

- `scheduled_tasks` 新增 3 列：
  - `slug TEXT`：项目内唯一可读别名（局部唯一索引 `UNIQUE(project_id, slug) WHERE slug IS NOT NULL`）。
  - `remote_trigger_enabled INTEGER NOT NULL DEFAULT 0`：是否允许通过远程窄口触发（默认关闭）。
  - `trigger_token_hash TEXT`：单任务 Trigger Token 的 SHA-256 十六进制哈希（服务端永不存明文，生成/轮换时仅返回一次明文）。
- `scheduled_task_runs` 新增 3 列：
  - `idempotency_key TEXT`：外部/Agent/Webhook 触发幂等键（局部唯一索引 `UNIQUE(task_id, idempotency_key) WHERE idempotency_key IS NOT NULL`）。
  - `trigger_source TEXT`：触发来源标识（如 `ui`、`api`、`session:<id>`、`task:<id>`、`webhook`）。
  - `chain_depth INTEGER NOT NULL DEFAULT 0`：触发链路深度。

## 5. HTTP 鉴权与窄口安全设计

Atelier 既有 `request-handler.ts` 要求所有 `/api/*` 满足本机 `Host`、同源、`x-atelier-token`（CSRF）与桌面配对头。对于远程遥控窄口 `POST /api/triggers/schedules/:idOrSlug`：

1. **窄口白名单**：仅对 `POST /api/triggers/schedules/<idOrSlug>` 放行 `x-atelier-token`、`desktopPairing` 与隧道透传的 `Host`，其余所有 `/api/*` 维持原有最严格本机校验不变。
2. **禁止浏览器跨站滥用**：即使在窄口路径，仍拒绝 `sec-fetch-site: cross-site` 或带浏览器 `Origin` 的跨站请求。
3. **单任务独立 Token 鉴权**：
   - Token 格式：`atk_<32字节随机base64url>`，服务端仅存储 `sha256(token)`。
   - 校验使用 `crypto.timingSafeEqual` 防止时序攻击；任务不存在、未开启远程触发、或 Token 无效统一返回 `401/403`，不泄露任务存在性。
   - 内置轻量单任务滑动窗口限流（默认每任务每分钟 30 次，可配置）。
4. **管理接口（需完整本机鉴权）**：
   - `POST /api/schedules/:id/trigger-token`：开启远程触发并生成/轮换单任务 Token（明文仅此次响应返回）。
   - `DELETE /api/schedules/:id/trigger-token`：关闭远程触发并立即吊销 Token。

## 6. UI 渐进披露策略

为保持 `/schedules` 简洁不复杂，采用渐进披露：
- **表单零冗余**：重复方式下拉框仅新增一项「仅按需触发（无定时）」；选中后自动隐藏时间/间隔/Cron 输入项；别名 `slug` 放在表单折叠/可选输入位。
- **详情面板按需展开**：在任务详情面板中增加默认收起的「触发方式与远程遥控」折叠区，内含别名展示、远程触发开关、一键生成/轮换/吊销 Token、以及可直接复制的 `curl` 调用示例。普通定时任务用户无需接触任何远程配置。
