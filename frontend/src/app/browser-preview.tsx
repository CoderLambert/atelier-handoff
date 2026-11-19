/**
 * @file 展示浏览器页面的实时预览。
 * @implementation 根据帧数据渲染地址、JPEG 画面及加载或错误状态。
 * @updated 2026-11-20T02:00+08:00
 */
import { Globe } from 'lucide-react';
import type { BrowserFrame } from '@/use-query/browser/use-browser-preview';

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
