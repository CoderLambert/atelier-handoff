/**
 * @file 获取项目浏览器预览帧。
 * @implementation 通过查询定时请求预览，按是否显示画面调整轮询间隔。
 * @updated 2026-11-20T02:00+08:00
 */
import { skipToken, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export interface BrowserFrame {
  title: string;
  url: string;
  jpeg?: string;
}

export function useBrowserPreview(projectId: string | undefined, showImage: boolean) {
  return useQuery({
    queryKey: ['browser-preview', projectId, showImage],
    gcTime: 0,
    refetchInterval: showImage ? 700 : 1800,
    retry: false,
    queryFn: !projectId
      ? skipToken
      : ({ signal }) =>
          api<{ frame: BrowserFrame | null }>(
            `/api/projects/${encodeURIComponent(projectId)}/browser-preview${showImage ? '?frame=1' : ''}`,
            { method: 'POST', signal },
          ),
  });
}
