/**
 * @file 请求项目目录选择并返回选择结果。
 * @implementation 桌面环境调用 preload 文件桥，其他环境调用项目 API；在异步操作前后处理取消信号。
 * @updated 2026-11-20T03:34:05+08:00
 */
import { useMutation } from '@tanstack/react-query';
import { api } from '@/api/client';
import { desktopFilesBridge } from '@/desktop-files';
import { projectKeys } from './keys';

export function usePickProjectDirectory() {
  return useMutation({
    mutationKey: projectKeys.pickDirectory,
    retry: false,
    mutationFn: async (signal: AbortSignal) => {
      signal.throwIfAborted();
      const bridge = desktopFilesBridge();
      if (bridge) {
        const path = await bridge.pickDirectory();
        signal.throwIfAborted();
        return { path };
      }
      return api<{ path: string | null }>('/api/projects/pick-directory', {
        method: 'POST',
        body: {},
        signal,
      });
    },
  });
}
