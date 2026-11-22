/**
 * @file 将会话绑定的智能体升级到给定版本。
 * @implementation 以会话和版本标识提交升级请求，工作区在成功后刷新会话快照。
 * @updated 2026-11-22T22:42:37+08:00
 */
import { useMutation } from '@tanstack/react-query';
import { api } from '@/api/client';

export function useUpgradeSessionAgent() {
  return useMutation({
    mutationFn: ({ sessionId, revisionId }: { sessionId: string; revisionId: string }) =>
      api(`/api/sessions/${encodeURIComponent(sessionId)}/upgrade-agent`, {
        method: 'POST',
        body: { revisionId },
      }),
  });
}
