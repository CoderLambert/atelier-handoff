/**
 * @file 展示浏览器下载文件的预览区域。
 * @implementation 延迟加载 FileVista，展示读取和渲染状态，并提供失败后的重试入口。
 * @updated 2026-11-20T20:14:00+08:00
 */
import { Component, lazy, Suspense, type ReactNode } from 'react';
import type { DesktopBrowserDownloadPreview } from '@shared/desktop-browser';
import { Button } from '@/components/ui/button';

const FilePreview = lazy(() => import('@/components/file-preview'));

export type BrowserDownloadPreviewState =
  | { kind: 'loading' }
  | { kind: 'ready'; file: DesktopBrowserDownloadPreview }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'error'; message: string };

function PreviewError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 p-5" role="alert">
      <p className="text-sm text-destructive wrap-anywhere">{message}</p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        重试预览
      </Button>
    </div>
  );
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
      <PreviewError
        message="文件预览未能加载。请重试，或用系统应用打开。"
        onRetry={this.props.onRetry}
      />
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
  if (state.kind === 'unavailable') {
    return (
      <div className="flex flex-col gap-2 p-5" role="status">
        <p className="text-sm font-medium">此文件暂不支持内置预览</p>
        <p className="text-sm text-muted-foreground">{state.reason}请用系统应用打开查看。</p>
      </div>
    );
  }
  if (state.kind === 'error') return <PreviewError message={state.message} onRetry={onRetry} />;
  const loading = (
    <p className="p-5 text-sm text-muted-foreground" role="status">
      正在加载预览…
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
