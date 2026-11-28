/**
 * @file 提供外部消息通道绑定与会话路由的 SQLite 仓储实现。
 * @implementation 通过 Drizzle 操作 channel_bindings 与 channel_sessions，支持按通道查询、幂等绑定、解绑和会话映射更新。
 * @updated 2026-11-28T10:30:00+08:00
 */
import { and, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ChannelBinding, ChannelId, ChannelSessionMapping } from '../../../shared/channels.js';
import { channelBindings, channelSessions } from '../schema/channels.js';

export function channelRepository(orm: BetterSQLite3Database) {
  return {
    listBindings(channel?: ChannelId): ChannelBinding[] {
      const rows = channel
        ? orm
            .select()
            .from(channelBindings)
            .where(eq(channelBindings.channel, channel))
            .orderBy(desc(channelBindings.createdAt))
            .all()
        : orm.select().from(channelBindings).orderBy(desc(channelBindings.createdAt)).all();
      return rows.map((row) => ({
        id: row.id,
        channel: row.channel as ChannelId,
        chatId: row.chatId,
        label: row.label,
        username: row.username ?? null,
        createdAt: row.createdAt,
      }));
    },

    findBinding(channel: ChannelId, chatId: string): ChannelBinding | undefined {
      const row = orm
        .select()
        .from(channelBindings)
        .where(and(eq(channelBindings.channel, channel), eq(channelBindings.chatId, chatId)))
        .get();
      if (!row) return undefined;
      return {
        id: row.id,
        channel: row.channel as ChannelId,
        chatId: row.chatId,
        label: row.label,
        username: row.username ?? null,
        createdAt: row.createdAt,
      };
    },

    upsertBinding(binding: ChannelBinding): ChannelBinding {
      orm
        .insert(channelBindings)
        .values({
          id: binding.id,
          channel: binding.channel,
          chatId: binding.chatId,
          label: binding.label,
          username: binding.username,
          createdAt: binding.createdAt,
        })
        .onConflictDoUpdate({
          target: [channelBindings.channel, channelBindings.chatId],
          set: {
            label: binding.label,
            username: binding.username,
          },
        })
        .run();
      return this.findBinding(binding.channel, binding.chatId) ?? binding;
    },

    deleteBinding(channel: ChannelId, chatId: string): boolean {
      const result = orm
        .delete(channelBindings)
        .where(and(eq(channelBindings.channel, channel), eq(channelBindings.chatId, chatId)))
        .run();
      return result.changes > 0;
    },

    getSession(channel: ChannelId, chatId: string): ChannelSessionMapping | undefined {
      const row = orm
        .select()
        .from(channelSessions)
        .where(and(eq(channelSessions.channel, channel), eq(channelSessions.chatId, chatId)))
        .get();
      if (!row) return undefined;
      return {
        channel: row.channel as ChannelId,
        chatId: row.chatId,
        atelierSessionId: row.atelierSessionId,
        projectId: row.projectId,
        workspacePath: row.workspacePath,
        updatedAt: row.updatedAt,
      };
    },

    upsertSession(mapping: ChannelSessionMapping): ChannelSessionMapping {
      orm
        .insert(channelSessions)
        .values({
          channel: mapping.channel,
          chatId: mapping.chatId,
          atelierSessionId: mapping.atelierSessionId,
          projectId: mapping.projectId,
          workspacePath: mapping.workspacePath,
          updatedAt: mapping.updatedAt,
        })
        .onConflictDoUpdate({
          target: [channelSessions.channel, channelSessions.chatId],
          set: {
            atelierSessionId: mapping.atelierSessionId,
            projectId: mapping.projectId,
            workspacePath: mapping.workspacePath,
            updatedAt: mapping.updatedAt,
          },
        })
        .run();
      return mapping;
    },

    deleteSession(channel: ChannelId, chatId: string): boolean {
      const result = orm
        .delete(channelSessions)
        .where(and(eq(channelSessions.channel, channel), eq(channelSessions.chatId, chatId)))
        .run();
      return result.changes > 0;
    },
  };
}
