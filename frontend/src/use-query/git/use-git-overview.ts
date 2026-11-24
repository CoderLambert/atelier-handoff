/**
 * @file 查询项目 Git 看板的分支与工作树。
 * @implementation 按项目隔离取消信号和读取结果。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { GitOverview } from '@shared/git-workbench';
import { gitKeys, gitUrl } from './keys';

export function useGitOverview(projectId: string) {
  const client = useQueryClient();
  const overview = useQuery({
    queryKey: gitKeys.overview(projectId),
    queryFn: ({ signal }) => api<GitOverview>(gitUrl(projectId), { signal }),
    retry: false,
  });
  return {
    overview,
    refresh: () => client.invalidateQueries({ queryKey: gitKeys.project(projectId) }),
  };
}
