/**
 * @file 提供工作区级会话与项目查询缓存协调动作。
 * @implementation 封装会话快照重验、移除、拉取及项目 Git 与引导缓存失效，使页面层不直接操作 QueryClient。
 * @updated 2026-11-27T19:25:00+08:00
 */
import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { keys } from '@/app/events';
import { gitKeys } from '@/use-query/git/keys';
import { sessionSnapshotOptions } from '@/use-query/sessions/use-session-snapshot';

export function useWorkspaceCache() {
  const client = useQueryClient();
  return useMemo(
    () => ({
      async revalidateSession(id: string) {
        void client.invalidateQueries({ queryKey: keys.sessions });
        void client.invalidateQueries({ queryKey: keys.runs });
        await client.invalidateQueries({ queryKey: keys.snapshot(id) });
      },
      invalidateSessionLists() {
        void client.invalidateQueries({ queryKey: keys.bootstrap });
        void client.invalidateQueries({ queryKey: keys.sessions });
      },
      invalidateBootstrap() {
        return client.invalidateQueries({ queryKey: keys.bootstrap });
      },
      invalidateSessions() {
        void client.invalidateQueries({ queryKey: keys.sessions });
      },
      invalidateProjectGit(projectId: string) {
        void client.invalidateQueries({ queryKey: gitKeys.project(projectId) });
      },
      removeSessionSnapshot(id: string) {
        client.removeQueries({ queryKey: keys.snapshot(id), exact: true });
      },
      fetchSessionSnapshot(id: string) {
        return client.fetchQuery(sessionSnapshotOptions(id));
      },
    }),
    [client],
  );
}
