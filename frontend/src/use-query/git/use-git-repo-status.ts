/**
 * @file 查询桌面端 Git 仓库的状态、分支与未解决冲突。
 * @implementation 按项目和工作树路径通过桌面桥查询状态，刷新由工作区同步统一触发。
 * @updated 2026-11-26T21:32:56+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { desktopGitBridge } from '@/desktop-git';
import type { GitRepoStatus } from '@shared/desktop-git';
import { gitKeys } from './keys';

export function useGitRepoStatus(projectId: string, cwd?: string) {
  const query = useQuery<GitRepoStatus | null>({
    queryKey: gitKeys.repoStatus(projectId, cwd),
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
  });
  return query.data ?? null;
}
