/**
 * @file 定义可恢复的工作区位置及会话身份解析。
 * @implementation 通过固定页面和会话路由白名单校验位置，允许终端面板路由并拒绝额外子路径，导出共享 schema。
 * @updated 2026-11-26T04:17:21+08:00
 */
import { z } from 'zod';

const sessionRoute =
  /^\/sessions\/([^/]+)(?:\/(trace|artifacts|messages|browser|terminal)(?:\/([^/]+))?)?$/u;
const pages = [
  '/sessions',
  '/runs',
  '/artifacts',
  '/extensions',
  '/agents',
  '/settings/models',
  '/settings/layout',
  '/settings/diagnostics',
] as const;
const uuid = z.uuid();

export function workspaceSessionId(path: string): string | undefined {
  const id = sessionRoute.exec(path)?.[1];
  return id && uuid.safeParse(id).success ? id : undefined;
}

export function isWorkspaceLocation(path: string): boolean {
  if (pages.some((page) => page === path)) return true;
  const match = sessionRoute.exec(path);
  if (!match || !uuid.safeParse(match[1]).success) return false;
  const [, , section, item] = match;
  if (section === 'messages') return uuid.safeParse(item).success;
  if (item !== undefined) return section === 'trace' && uuid.safeParse(item).success;
  return true;
}

export const workspaceLocationSchema = z.strictObject({
  path: z.string().max(180).refine(isWorkspaceLocation),
});
