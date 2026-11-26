/**
 * @file 查询公开 GitHub 导入的本机账号连接状态。
 * @implementation 从运行时读取账号名，不访问 GitHub 凭据。
 * @updated 2026-11-26T15:40:00+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { githubPublicAuthView } from '@shared/github-public-auth';
import { githubConnection } from './keys';

export function useGithubPublicConnection(enabled: boolean) {
  return useQuery({
    queryKey: githubConnection.key,
    queryFn: ({ signal }) =>
      api(githubConnection.endpoint, { signal }).then((data) => githubPublicAuthView.parse(data)),
    enabled,
    retry: false,
  });
}
