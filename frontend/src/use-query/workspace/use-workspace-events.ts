/**
 * @file 连接工作区 SSE 事件流与查询缓存失效。
 * @implementation 在查询层获取 QueryClient 并委派给既有的运行事件订阅逻辑。
 * @updated 2026-11-27T19:25:00+08:00
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRunEvents } from '@/app/events';

export function useWorkspaceEvents(cursor?: number, viewedSessionId?: string) {
  const client = useQueryClient();
  useRunEvents(client, cursor, viewedSessionId);
}
