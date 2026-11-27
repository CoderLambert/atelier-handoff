/**
 * @file 将会话绑定的智能体升级到给定版本。
 * @implementation 以会话和版本标识提交升级请求，成功后刷新对应会话快照、运行与会话列表缓存。
 * @updated 2026-11-27T19:25:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { sessionKeys } from './keys';

export function useUpgradeSessionAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, revisionId }: { sessionId: string; revisionId: string }) =>
      api(`/api/sessions/${encodeURIComponent(sessionId)}/upgrade-agent`, {
        method: 'POST',
        body: { revisionId },
      }),
    onSuccess: async (_, { sessionId }) => {
      void client.invalidateQueries({ queryKey: ['sessions'] });
      void client.invalidateQueries({ queryKey: ['runs'] });
      await client.invalidateQueries({ queryKey: sessionKeys.snapshot(sessionId) });
    },
  });
}
