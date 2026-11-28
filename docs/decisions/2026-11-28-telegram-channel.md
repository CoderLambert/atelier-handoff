# 外部消息通道持久化架构决策（Telegram v1）

## 背景
Atelier 需要通过适配器注册表模式接入 Telegram 等外部消息通道，将已授权聊天账号绑定与 `(channel, chatId) -> (atelierSessionId, workspacePath)` 会话映射持久化到现有 SQLite 数据库中。

## 决策
- 新增 v16 迁移 `server/db/migrations/0016-channels.sql` 与 `apply-channels.ts`，仅新增 `channel_bindings` 和 `channel_sessions` 两张表。
- 运行时读写完全通过 Drizzle ORM 仓储 `server/db/repositories/channels.ts` 进行，仅在迁移加载器 `apply-channels.ts` 中调用 `db.exec(...)` 执行固定建表 DDL。
- Bot Token 等敏感凭证不进入 SQLite，而是通过 Electron `safeStorage` 加密存储于桌面端 profile 目录。
