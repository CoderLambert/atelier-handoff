/**
 * @file 创建预览已核对的开发会话。
 * @implementation 提交原请求与预期 SHA，创建成功后刷新对应 Git 项目。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { DevelopmentCreate, GitSessionWorkspace } from '@shared/git-workbench';
import type { Session } from '@shared/types';
import { gitKeys, gitUrl } from './keys';

export function useCreateDevelopmentSession(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: DevelopmentCreate) =>
      api<{ session: Session; workspace: GitSessionWorkspace }>(gitUrl(projectId) + '/sessions', {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: gitKeys.project(projectId) });
    },
  });
}
