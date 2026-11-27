/**
 * @file 执行智能体的创建、保存、复制与归档变更操作。
 * @implementation 在提交前取消在途列表查询、乐观回写缓存条目并同步失效智能体和扩展目录。
 * @updated 2026-11-27T22:35:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentCard } from '@shared/types';
import { api } from '@/api/client';
import { extensionKeys } from '@/use-query/extensions/keys';
import type { AgentOperation } from '@/features/agents/agent-model';
import { agentEndpoint, agentKeys } from './keys';

export function useAgentMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: agentKeys.mutations(projectId),
    scope: { id: `agents:${projectId}` },
    mutationFn: async (operation: AgentOperation) => {
      const suffix =
        operation.action === 'create'
          ? undefined
          : `${encodeURIComponent(operation.id)}${operation.action === 'save' ? '' : `/${operation.action}`}`;
      const body =
        operation.action === 'create'
          ? operation.config
          : operation.action === 'save'
            ? { baseRevisionId: operation.baseRevisionId, config: operation.config }
            : { baseRevisionId: operation.baseRevisionId };
      const result = await api<{ agent: AgentCard }>(agentEndpoint(projectId, suffix), {
        method: operation.action === 'save' ? 'PATCH' : 'POST',
        body,
      });
      if (!result?.agent?.id) throw new Error('操作响应缺少智能体信息，请刷新列表确认结果。');
      return result.agent;
    },
    onMutate: () => client.cancelQueries({ queryKey: agentKeys.list(projectId) }),
    onSuccess: (agent) => {
      client.setQueryData<AgentCard[]>(agentKeys.list(projectId), (items) =>
        items?.some((value) => value.id === agent.id)
          ? items.map((value) => (value.id === agent.id ? agent : value))
          : [...(items ?? []), agent],
      );
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: agentKeys.list(projectId) }),
        client.invalidateQueries({ queryKey: extensionKeys.list(projectId) }),
      ]);
    },
  });
}
