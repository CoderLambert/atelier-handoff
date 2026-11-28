/**
 * @file 提供外部消息通道绑定与会话映射的 REST HTTP 路由。
 * @implementation 通过 Store 的 Drizzle 仓储暴露 channel_bindings 与 channel_sessions 的增删查改接口，供桌面端通道管理器调用。
 * @updated 2026-11-28T11:10:00+08:00
 */
import { z } from 'zod';
import { channelIdSchema } from '../../../shared/channels.js';
import { AppError } from '../../../shared/errors.js';
import type { Store } from '../../store.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';

const upsertBindingBodySchema = z.strictObject({
  id: z.string().min(1),
  channel: channelIdSchema,
  chatId: z.string().min(1),
  label: z.string(),
  username: z.string().nullable(),
});

const upsertSessionBodySchema = z.strictObject({
  channel: channelIdSchema,
  chatId: z.string().min(1),
  atelierSessionId: z.string().min(1),
  workspacePath: z.string(),
  projectId: z.string().min(1),
});

export function createChannelRoutes(store: Store): RouteHandler {
  return async ({ req, res, url, parts, method }) => {
    const [api, resource, sub, channelParam, chatIdParam] = parts;
    if (api !== 'api' || resource !== 'channels') return false;

    if (sub === 'bindings') {
      if (parts.length === 3 && method === 'GET') {
        const rawChannel = url.searchParams.get('channel');
        const channel = rawChannel ? channelIdSchema.parse(rawChannel) : undefined;
        return json(res, { items: store.channels.listBindings(channel) });
      }
      if (parts.length === 3 && method === 'POST') {
        const parsed = upsertBindingBodySchema.parse(await body(req));
        const binding = store.channels.upsertBinding({
          ...parsed,
          createdAt: new Date().toISOString(),
        });
        return json(res, { binding }, 201);
      }
      if (parts.length === 5 && channelParam && chatIdParam && method === 'DELETE') {
        const channel = channelIdSchema.parse(channelParam);
        const deleted = store.channels.deleteBinding(channel, chatIdParam);
        store.channels.deleteSession(channel, chatIdParam);
        return json(res, { deleted });
      }
    }

    if (sub === 'sessions') {
      if (parts.length === 5 && channelParam && chatIdParam && method === 'GET') {
        const channel = channelIdSchema.parse(channelParam);
        const session = store.channels.getSession(channel, chatIdParam) ?? null;
        return json(res, { session });
      }
      if (parts.length === 3 && method === 'PUT') {
        const parsed = upsertSessionBodySchema.parse(await body(req));
        const session = store.channels.upsertSession({
          ...parsed,
          updatedAt: new Date().toISOString(),
        });
        return json(res, { session });
      }
      if (parts.length === 5 && channelParam && chatIdParam && method === 'DELETE') {
        const channel = channelIdSchema.parse(channelParam);
        const deleted = store.channels.deleteSession(channel, chatIdParam);
        return json(res, { deleted });
      }
    }

    throw new AppError('NOT_FOUND', '接口不存在。', 404);
  };
}
