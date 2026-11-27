# C6 · 待处理消息迁入 Drizzle、统一中断恢复与热路径索引查询

## 问题与范围

延续 [ORM 架构决策](2026-11-21-orm-architecture.md) 第 3 步（队列、回执与审批）：

1. `server/message-queue.ts` 仍有 17 处手写 SQL，恢复语句写在构造函数里，不在 `Store.recover()` 的单事务内。
2. `Store.recover()` 把转录收尾、Bash 状态、审批取消硬编码进数据门面，并对 `runs × tools × permissions` 全表反序列化后嵌套过滤。
3. `execution-slots`、队列调度、`permissions`、`agent` 收尾、运行详情路由在热路径上调用 `store.list('runs'|'tools'|'permissions'|'artifacts').filter(...)`。
4. 每新增一张表或仓储都要同时改 `connection.ts` 的返回值、`Store` 字段、构造赋值和 `initialize()` 参数。

本轮不改变 HTTP/SSE 契约、队列语义、授权语义或 JSON 记录格式；只新增 v11 索引迁移。

## 取舍

- **v11 迁移 `0011-runtime-hotpath-indexes.sql`**：为 `runs.status`、`tools.run_id/status`、`permissions.run_id/status`、`artifacts.run_id` 增加由 `data` 派生的 VIRTUAL 列，并建立普通 B-tree 索引（`runs(status)`、`tools(run_id,status)`、`tools(status)`、`permissions(run_id,status)`、`permissions(status)`、`artifacts(run_id)`）。按会话查活动运行沿用 v6 的 `runs(session_id)` 索引，该会话的运行数很少，不再另建复合索引。`ALTER TABLE ADD COLUMN` 保留历史 rowid。没有选择部分索引：Drizzle 以绑定参数发出 `status IN (?,…)`，SQLite 无法在预编译期把绑定参数与部分索引的常量谓词对上，普通索引才能稳定得到 `SEARCH … USING INDEX`。
- **`MessageQueue` 迁入 `server/db/repositories/message-queue.ts`**：全部用 Drizzle 类型化查询实现，`heads()` 在应用层按会话取首条，不再依赖窗口函数；`referencesAttachment` 读取未撤回的 payload 后由 Zod 解析 `intent.request.attachmentIds`，不再用 `json_each`。`server/message-queue.ts` 从 `scripts/database-legacy.json` 清零，不新增例外。
- **`server/modules/runs/recovery.ts`**：`recoverInterruptedRuntime(store)` 在同一 `store.transaction` 内完成子任务中断、队列恢复、转录顺序提升、工具/审批取消与运行中断；`finalizeUnfinishedRunTools` 同时供 `agent.ts` 运行收尾复用。队列恢复因此与运行恢复同时提交或同时回滚。启动顺序不变（`store.recover()` 先于 `new MessageQueue`）。
- **仓储组合 `store.repos` 与迁移注册表**：`openWorkbenchDatabase` 返回 `repos` 与有序 `migrations`，`LATEST_SCHEMA_VERSION` 由 `connection.ts` 导出、`Store` 重导出。`Store` 保留既有 11 个仓储名的只读访问器以免波及调用方；新仓储仅经 `store.repos` 暴露。v1–v5 的历史 SQL 原样保留，指纹不变。

## 验证与回退

- 新增 `tests/runtime-orm-queries.test.ts`：v10→v11 升级保留 rowid 与数据、迁移中途失败回滚、`EXPLAIN QUERY PLAN` 断言 9 条热路径均为 `SEARCH … USING INDEX` 且无 `SCAN`、恢复在注入故障时队列与运行一并回滚、恢复幂等、队列 FIFO/优先/暂停/回执/撤回/附件引用与旧语义一致。
- 既有迁移与快照测试同步到 v11；再运行 `npm run check`、`npm run check:headers`、`npm run build`、`npm run build:desktop`、`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 与隔离 Wayland 真实 Electron 烟测。
- 回退：升级沿用[迁入与备份约定](2026-11-20-desktop-data-migration.md)，先做 WAL 一致性备份。v11 只增加派生列与索引，旧版本程序打开升级前备份即可；整体回退 C6 提交后，已升级库的 `user_version=11` 会被旧程序拒绝，需用升级前备份恢复。
