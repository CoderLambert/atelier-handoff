/**
 * @file 定义外部消息通道绑定与会话路由的 Drizzle 表结构。
 * @implementation 映射 channel_bindings 与 channel_sessions 两张表，供通道仓储读写。
 * @updated 2026-11-28T10:30:00+08:00
 */
import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const channelBindings = sqliteTable('channel_bindings', {
  id: text('id').primaryKey().notNull(),
  channel: text('channel').notNull(),
  chatId: text('chat_id').notNull(),
  label: text('label').notNull().default(''),
  username: text('username'),
  createdAt: text('created_at').notNull(),
});

export const channelSessions = sqliteTable(
  'channel_sessions',
  {
    channel: text('channel').notNull(),
    chatId: text('chat_id').notNull(),
    atelierSessionId: text('atelier_session_id').notNull(),
    projectId: text('project_id').notNull(),
    workspacePath: text('workspace_path').notNull().default(''),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.channel, table.chatId] })],
);
