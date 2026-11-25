/**
 * @file 查询桌面端 Git 仓库的状态、分支与未解决冲突。
 * @implementation 按工作树绝对路径隔离状态，周期性自动刷新并提供主动失效触发器。
 * @updated 2026-11-25T03:30:00+08:00
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { desktopGitBridge } from '@/desktop-git';
import type { GitRepoStatus } from '@shared/desktop-git';
import { gitKeys } from './keys';

export function useGitRepoStatus(cwd?: string) {
  const client = useQueryClient();
  const query = useQuery<GitRepoStatus | null>({
    queryKey: gitKeys.repoStatus(cwd),
    queryFn: async () => {
      const bridge = desktopGitBridge();
      if (!bridge || !cwd) return null;
      try {
        return await bridge.getStatus(cwd);
      } catch {
        return null;
      }
    },
    enabled: Boolean(cwd),
    refetchInterval: 8_000,
  });

  return {
    status: query.data ?? null,
    isLoading: query.isLoading,
    refetch: () => query.refetch(),
    invalidate: () => client.invalidateQueries({ queryKey: gitKeys.repoStatus(cwd) }),
  };
}
