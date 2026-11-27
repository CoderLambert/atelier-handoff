/**
 * @file 为指定智能体修订版本创建新会话并刷新工作区查询缓存。
 * @implementation 归口智能体目录页开启会话的 mutation，完成后失效会话列表、引导数据与项目智能体列表。
 * @updated 2026-11-27T22:35:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentCard, Session } from '@shared/types';
import { api } from '@/api/client';
import { keys } from '@/app/events';
import { agentKeys } from './keys';

export function useStartAgentSession(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: agentKeys.mutations(projectId),
    mutationFn: (item: AgentCard) =>
      api<{ session: Session }>('/api/sessions', {
        method: 'POST',
        body: { projectId, agentRevisionId: item.revisionId },
      }),
    onSuccess: ({ session }) => {
      if (!session?.id) throw new Error('创建会话响应缺少会话信息，请刷新会话列表确认结果。');
      void client.invalidateQueries({ queryKey: keys.sessions });
      void client.invalidateQueries({ queryKey: keys.bootstrap });
    },
    onSettled: () => client.invalidateQueries({ queryKey: agentKeys.list(projectId) }),
  });
}
