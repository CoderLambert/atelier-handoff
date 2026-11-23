/**
 * @file 提供智能体配置的前端数据操作与查询。
 * @implementation 管理项目智能体列表与变更操作，纯模型与依赖校验由 agent-model 提供。
 * @updated 2026-11-23T18:25:00+08:00
 */
import { getTranslator } from '@/i18n';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentCapability, AgentCard, AgentConfig, Extension } from '@shared/types';
import { api } from '@/api/client';
import { extensionKeys } from '@/features/extensions/api';
import type { AgentOperation } from './agent-model';

export const agentKeys = {
  list: (projectId: string) => ['agents', projectId, 'list'] as const,
  mutations: (projectId: string) => ['agents', projectId, 'mutation'] as const,
};
export const agentEndpoint = (projectId: string, suffix?: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/agents${suffix ? `/${suffix}` : ''}`;
export const agentsQuery = (projectId: string) =>
  queryOptions({
    queryKey: agentKeys.list(projectId),
    enabled: Boolean(projectId),
    queryFn: async ({ signal }) => {
      const result = await api<{ items: AgentCard[] }>(agentEndpoint(projectId), { signal });
      if (!Array.isArray(result?.items)) throw new Error('智能体列表响应缺少 items，请重新加载。');
      return result.items;
    },
  });

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

export * from './agent-model';
