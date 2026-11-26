/**
 * @file 订阅当前 Git 面板工作树的变动。
 * @implementation 合并读请求与变动通知，重读该项目的活跃 Git 查询，定期校准漏报并清理订阅。
 * @updated 2026-11-26T21:22:00+08:00
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { gitKeys, gitTreeUrl } from './keys';

export function useGitWorkspaceSync(projectId: string, worktreeId?: string) {
  const client = useQueryClient();
  useEffect(() => {
    const filters = { queryKey: gitKeys.live(projectId) };
    let disposed = false;
    let refreshing = false;
    let pending = false;
    async function refresh() {
      if (disposed || document.visibilityState !== 'visible') return;
      pending = true;
      if (refreshing) return;
      refreshing = true;
      try {
        while (pending && !disposed) {
          // An existing read can have captured the state before this notification.
          const alreadyFetching = client.isFetching(filters) > 0;
          pending = alreadyFetching;
          await client.invalidateQueries(filters, { cancelRefetch: false });
        }
      } finally {
        refreshing = false;
      }
    }
    const revalidate = () => void refresh();
    const source = worktreeId
      ? new EventSource(gitTreeUrl(projectId, worktreeId) + '/changes')
      : undefined;
    if (source) source.onmessage = revalidate;
    // Network filesystems and exhausted watch limits can drop or delay filesystem events.
    const timer = window.setInterval(revalidate, 15_000);
    document.addEventListener('visibilitychange', revalidate);
    return () => {
      disposed = true;
      source?.close();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [client, projectId, worktreeId]);
}
