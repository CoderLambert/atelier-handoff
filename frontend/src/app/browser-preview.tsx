import { useQuery } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import { api } from '@/api/client';

interface BrowserFrame {
  title: string;
  url: string;
  jpeg?: string;
}

export function useBrowserPreview(projectId: string | undefined, showImage: boolean) {
  return useQuery({
    queryKey: ['browser-preview', projectId, showImage],
    enabled: Boolean(projectId),
    gcTime: 0,
    refetchInterval: showImage ? 700 : 1800,
    retry: false,
    queryFn: ({ signal }) =>
      api<{ frame: BrowserFrame | null }>(
        `/api/projects/${encodeURIComponent(projectId!)}/browser-preview${showImage ? '?frame=1' : ''}`,
        { method: 'POST', signal },
      ),
  });
}

export function BrowserPreview({ frame, error }: { frame?: BrowserFrame | null; error: boolean }) {
  return (
    <section className="workspace-browser" aria-label="浏览器实时预览">
      {frame ? (
        <>
          <header className="workspace-browser-address">
            <Globe size={16} aria-hidden="true" />
            <div>
              <strong title={frame.title}>{frame.title || '浏览器'}</strong>
              <span title={frame.url}>{frame.url}</span>
            </div>
          </header>
          {frame.jpeg ? (
            <img
              className="workspace-browser-image"
              src={`data:image/jpeg;base64,${frame.jpeg}`}
              alt={`当前页面 ${frame.title || frame.url}`}
            />
          ) : (
            <p className="empty-text px-4 py-4" role="status">
              正在读取浏览器画面…
            </p>
          )}
        </>
      ) : (
        <p className="empty-text px-4 py-4">
          {error ? '暂时无法读取浏览器预览。' : '让 Playwright 打开网页后，画面会显示在这里。'}
        </p>
      )}
    </section>
  );
}
