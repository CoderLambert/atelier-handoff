/**
 * @file 从快照恢复当前会话的工作树。
 * @implementation 请求运行时核对原目录、分支和文件内容，返回恢复后的会话。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { GitRestoreRequest, GitSessionWorkspace } from '@shared/git-workbench';
import type { Session } from '@shared/types';
import { gitKeys } from '../git/keys';

export function useRestoreWorktree(sessionId: string, projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: GitRestoreRequest) =>
      api<{ session: Session; workspace: GitSessionWorkspace }>(
        '/api/sessions/' + encodeURIComponent(sessionId) + '/worktree/restore',
        { method: 'POST', body },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: gitKeys.project(projectId) });
    },
  });
}
