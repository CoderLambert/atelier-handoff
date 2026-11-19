/**
 * @file 请求系统目录选择器。
 * @implementation 调用可取消的目录选择 mutation，返回选中的本机路径。
 * @updated 2026-11-20T02:00+08:00
 */
import { useMutation } from '@tanstack/react-query';
import { api } from '@/api/client';
import { projectKeys } from './keys';

export function usePickProjectDirectory() {
  return useMutation({
    mutationKey: projectKeys.pickDirectory,
    retry: false,
    mutationFn: (signal: AbortSignal) =>
      api<{ path: string | null }>('/api/projects/pick-directory', {
        method: 'POST',
        body: {},
        signal,
      }),
  });
}
