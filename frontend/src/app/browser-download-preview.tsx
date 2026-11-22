/**
 * @file 展示浏览器下载文件的预览区域。
 * @implementation 延迟加载 FileVista，展示读取和渲染状态，并提供失败后的重试入口。
 * @updated 2026-11-20T20:14:00+08:00
 */
import { Component, lazy, Suspense, type ReactNode } from 'react';
import {
  browserDownloadPreviewMaxBytes,
  type DesktopBrowserDownloadPreview,
} from '@shared/desktop-browser';
import { Button } from '@/components/ui/button';
import { translateError, useUiTranslation } from '@/i18n';

const FilePreview = lazy(() => import('@/components/file-preview'));

export type BrowserDownloadPreviewState =
  | { kind: 'loading' }
  | { kind: 'ready'; file: DesktopBrowserDownloadPreview }
  | { kind: 'unavailable'; reason: 'unsupportedFormat' | 'tooLarge' }
  | { kind: 'error'; error: unknown };

function PreviewError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useUiTranslation('browser');
  return (
    <div className="flex flex-col items-start gap-3 p-5" role="alert">
      <p className="text-sm text-destructive wrap-anywhere">{message}</p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        {t('preview.retry')}
      </Button>
    </div>
  );
}

function PreviewLoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useUiTranslation('browser');
  return <PreviewError message={t('preview.loadFailed')} onRetry={onRetry} />;
}

class PreviewBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <PreviewLoadError onRetry={this.props.onRetry} />
    ) : (
      this.props.children
    );
  }
}

export function BrowserDownloadPreview({
  state,
  onRetry,
}: {
  state: BrowserDownloadPreviewState;
  onRetry: () => void;
}) {
  const { t, locale } = useUiTranslation('browser');
  if (state.kind === 'unavailable') {
    return (
      <div className="flex flex-col gap-2 p-5" role="status">
        <p className="text-sm font-medium">{t('preview.unavailable')}</p>
        <p className="text-sm text-muted-foreground">
          {state.reason === 'tooLarge'
            ? t('preview.tooLarge', {
                size: (browserDownloadPreviewMaxBytes / 1024 ** 2).toLocaleString(locale, {
                  maximumFractionDigits: 1,
                }),
              })
            : t('preview.unsupportedFormat')}
        </p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <PreviewError
        message={translateError(state.error, t('preview.readFailed'))}
        onRetry={onRetry}
      />
    );
  }
  const loading = (
    <p className="p-5 text-sm text-muted-foreground" role="status">
      {t('preview.loading')}
    </p>
  );
  if (state.kind === 'loading') return loading;
  return (
    <PreviewBoundary onRetry={onRetry}>
      <Suspense fallback={loading}>
        <FilePreview {...state.file} />
      </Suspense>
    </PreviewBoundary>
  );
}
