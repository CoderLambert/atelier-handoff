/**
 * @file 查询项目下的智能体配置目录。
 * @implementation 暴露标准化 queryOptions、订阅 Hook 与按需强制刷新封装，替代组件层直连 QueryClient。
 * @updated 2026-11-27T22:35:00+08:00
 */
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentCard } from '@shared/types';
import { api } from '@/api/client';
import { agentEndpoint, agentKeys } from './keys';

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

export function useAgents(projectId: string) {
  return useQuery(agentsQuery(projectId));
}

export function useFetchFreshAgents(projectId: string) {
  const client = useQueryClient();
  return () => client.fetchQuery({ ...agentsQuery(projectId), staleTime: 0 });
}
