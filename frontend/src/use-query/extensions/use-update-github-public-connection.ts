/**
 * @file 连接或断开 Atelier 的 GitHub CLI 导入授权。
 * @implementation 将用户操作提交给运行时，并更新连接状态缓存。
 * @updated 2026-11-26T15:40:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { githubPublicAuthView } from '@shared/github-public-auth';
import { githubConnection } from './keys';

export function useUpdateGithubPublicConnection() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: githubConnection.key,
    scope: { id: 'github-public-connection' },
    mutationFn: (connect: boolean) =>
      api(githubConnection.endpoint, { method: 'PUT', body: { connect } }).then((data) =>
        githubPublicAuthView.parse(data),
      ),
    onSuccess: async (view) => {
      await client.cancelQueries({ queryKey: githubConnection.key });
      client.setQueryData(githubConnection.key, view);
    },
  });
}
