/**
 * @file 提供独立快捷操作偏好的 HTTP 接口。
 * @implementation 精确匹配读写路径，按共享 schema 校验后调用注入的偏好仓储，沿用公共请求保护和错误响应。
 * @updated 2026-11-27T01:18:19+08:00
 */
import { shortcutPreferencesSchema, type ShortcutPreferences } from '../../../shared/shortcuts.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';

export interface ShortcutPreferenceOptions {
  shortcutPreferences: {
    read(): ShortcutPreferences;
    save(preferences: ShortcutPreferences): ShortcutPreferences;
  };
}

export function createShortcutPreferenceRoutes({
  shortcutPreferences,
}: ShortcutPreferenceOptions): RouteHandler {
  return async ({ req, res, url, method }) => {
    if (url.pathname !== '/api/settings/shortcuts') return false;
    if (method === 'GET') return json(res, shortcutPreferences.read());
    if (method === 'PATCH')
      return json(res, shortcutPreferences.save(shortcutPreferencesSchema.parse(await body(req))));
    return false;
  };
}
