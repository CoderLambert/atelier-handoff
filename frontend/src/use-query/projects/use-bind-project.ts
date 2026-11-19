/**
 * @file 提交项目目录绑定请求。
 * @implementation 通过 useMutation 提交目录路径，成功后更新项目启动快照。
 * @updated 2026-11-20T02:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Project } from '@shared/types';
import { api } from '@/api/client';
import { projectKeys } from './keys';

export function useBindProject() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: projectKeys.bind,
    retry: false,
    mutationFn: (path: string) =>
      api<{ project: Project }>('/api/projects', { method: 'POST', body: { path } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['bootstrap'] });
    },
  });
}
