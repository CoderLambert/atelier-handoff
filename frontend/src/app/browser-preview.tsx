/**
 * @file 展示浏览器页面的实时预览。
 * @implementation 根据帧数据渲染地址、JPEG 画面及加载或错误状态。
 * @updated 2026-11-20T02:00+08:00
 */
import { Globe } from 'lucide-react';
import { useUiTranslation } from '@/i18n';
import type { BrowserFrame } from '@/use-query/browser/use-browser-preview';

export function BrowserPreview({ frame, error }: { frame?: BrowserFrame | null; error: boolean }) {
  const { t } = useUiTranslation('browser');
  return (
    <section className="workspace-browser" aria-label={t('live.label')}>
      {frame ? (
        <>
          <header className="workspace-browser-address">
            <Globe aria-hidden="true" />
            <div>
              <strong title={frame.title}>{frame.title || t('live.browser')}</strong>
              <span title={frame.url}>{frame.url}</span>
            </div>
          </header>
          {frame.jpeg ? (
            <img
              className="workspace-browser-image"
              src={`data:image/jpeg;base64,${frame.jpeg}`}
              alt={t('live.pageAlt', { page: frame.title || frame.url })}
            />
          ) : (
            <p className="empty-text px-4 py-4" role="status">
              {t('live.loading')}
            </p>
          )}
        </>
      ) : (
        <p className="empty-text px-4 py-4">{t(error ? 'live.unavailable' : 'live.empty')}</p>
      )}
    </section>
  );
}
