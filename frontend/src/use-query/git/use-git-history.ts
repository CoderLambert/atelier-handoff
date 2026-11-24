/**
 * @file 按本机提交分页查询 Git 历史。
 * @implementation 固定当前视图的基线 SHA，按服务端游标加载后续提交。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { GitHistory } from '@shared/git-workbench';
import { gitKeys, gitUrl } from './keys';

export function useGitHistory(projectId: string, oid?: string) {
  return useInfiniteQuery({
    queryKey: gitKeys.history(projectId, oid),
    enabled: !!oid,
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      api<GitHistory>(
        gitUrl(projectId) +
          '/history?' +
          new URLSearchParams({ oid: oid ?? '', offset: String(pageParam) }),
        { signal },
      ),
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    retry: false,
  });
}
