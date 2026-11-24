/**
 * @file 按本机提交分页查询 Git 历史。
 * @implementation 固定当前视图的基线 SHA，按服务端游标加载后续提交。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { GitHistory, GitHistoryQuery } from '@shared/git-workbench';
import { gitKeys, gitUrl } from './keys';

export function useGitHistory(projectId: string, oid?: string, filters?: GitHistoryQuery) {
  const query = filters?.query?.trim();
  const author = filters?.author?.trim();
  const since = filters?.since?.trim();

  return useInfiniteQuery({
    queryKey: gitKeys.history(projectId, oid, filters),
    enabled: !!oid,
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams({ oid: oid ?? '', offset: String(pageParam) });
      if (query) params.set('query', query);
      if (author && author !== 'all') params.set('author', author);
      if (since && since !== 'all') params.set('since', since);
      return api<GitHistory>(gitUrl(projectId) + '/history?' + params.toString(), { signal });
    },
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    retry: false,
  });
}
