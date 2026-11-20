/**
 * @file 提供原生浏览器下载入口、进度与保存位置列表。
 * @implementation 消费项目下载快照，使用 Dialog 展示记录，通过类型化桥接请求取消或定位，并播报完成和失败。
 * @updated 2026-11-20T18:19:08+08:00
 */
import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, Check, CircleAlert, Download, File, FolderOpen } from 'lucide-react';
import {
  browserDownloadPreviewMaxBytes,
  browserDownloadPreviewMime,
  type DesktopBrowserAction,
  type DesktopBrowserBridge,
  type DesktopBrowserDownload,
  type DesktopBrowserState,
} from '@shared/desktop-browser';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/components/ui/utils';
import {
  BrowserDownloadPreview,
  type BrowserDownloadPreviewState,
} from './browser-download-preview';

type DownloadAction = Extract<
  DesktopBrowserAction,
  'reveal-download' | 'cancel-download' | 'open-download-directory' | 'open-download'
>;
const statusLabels: Record<DesktopBrowserDownload['status'], string> = {
  progressing: '正在下载',
  completed: '下载完成',
  cancelled: '已取消',
  interrupted: '下载失败',
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  const amount = bytes / 1024 ** (index + 1);
  return `${amount.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ${units[index]}`;
}

function downloadName(download: DesktopBrowserDownload) {
  return download.path.split(/[\\/]/).at(-1) || download.filename;
}

function downloadProgress(download: DesktopBrowserDownload) {
  const received = formatBytes(download.receivedBytes);
  if (download.totalBytes <= 0) return `已接收 ${received}，总大小未知`;
  const percent = Math.min(100, Math.floor((download.receivedBytes / download.totalBytes) * 100));
  return `${percent}% · ${received} / ${formatBytes(download.totalBytes)}`;
}

function DownloadPath({ path }: { path: string }) {
  const label = path || '正在确定保存位置…';
  return (
    <details className="min-w-0 text-xs text-muted-foreground">
      <summary className="cursor-pointer truncate" title={label}>
        保存路径：<bdi>{label}</bdi>
      </summary>
      <p className="mt-1 select-text wrap-anywhere" dir="auto">
        {label}
      </p>
    </details>
  );
}

function focusPreviewBack(button: HTMLButtonElement | null) {
  button?.focus();
}

export function BrowserDownloads({
  projectId,
  state,
  bridge,
}: {
  projectId: string;
  state?: DesktopBrowserState;
  bridge: DesktopBrowserBridge;
}) {
  const downloads = state?.downloads;
  const activeCount =
    downloads?.filter((download) => download.status === 'progressing').length ?? 0;
  const summaryId = useId();
  const previous = useRef<Map<string, DesktopBrowserDownload['status']> | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const previewRequest = useRef(0);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{
    download: DesktopBrowserDownload;
    attempt: number;
    state: BrowserDownloadPreviewState;
  } | null>(null);
  const [pending, setPending] = useState<{ action: DownloadAction; id?: string } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [lastResult, setLastResult] = useState<DesktopBrowserDownload['status']>();
  const summary = activeCount
    ? `${activeCount} 个下载进行中`
    : error || failure || notice || '查看下载记录与保存位置';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      previewRequest.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!downloads) return;
    const finished = previous.current
      ? downloads.filter(
          (download) =>
            download.status !== 'progressing' &&
            previous.current?.get(download.id) !== download.status,
        )
      : [];
    previous.current = new Map(downloads.map((download) => [download.id, download.status]));
    if (!finished.length) return;
    setNotice(
      finished
        .filter((download) => download.status !== 'interrupted')
        .map((download) => `${downloadName(download)}：${statusLabels[download.status]}。`)
        .join(' '),
    );
    setFailure(
      finished
        .filter((download) => download.status === 'interrupted')
        .map(
          (download) =>
            `${downloadName(download)}：下载失败。${download.error || '请返回网页重新下载。'}`,
        )
        .join(' '),
    );
    setLastResult(
      finished.some((download) => download.status === 'interrupted')
        ? 'interrupted'
        : finished[0]?.status,
    );
  }, [downloads]);

  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) {
      previewRequest.current += 1;
      setPreview(null);
    }
  }

  function returnToDownloads() {
    previewRequest.current += 1;
    setPreview(null);
    requestAnimationFrame(() => {
      if (mounted.current && previewTrigger.current?.isConnected) previewTrigger.current.focus();
    });
  }

  async function openPreview(download: DesktopBrowserDownload, trigger?: HTMLButtonElement) {
    if (!state || !mounted.current || pending || download.status !== 'completed' || !download.path)
      return;
    if (trigger) previewTrigger.current = trigger;
    const attempt = ++previewRequest.current;
    const selection = { download, attempt };
    const name = downloadName(download);
    setError('');
    if (!browserDownloadPreviewMime(name)) {
      setPreview({
        ...selection,
        state: { kind: 'unavailable', reason: '此文件格式暂无内置预览。' },
      });
      return;
    }
    if (Math.max(download.receivedBytes, download.totalBytes) > browserDownloadPreviewMaxBytes) {
      setPreview({
        ...selection,
        state: {
          kind: 'unavailable',
          reason: `文件超过 ${formatBytes(browserDownloadPreviewMaxBytes)} 的预览上限。`,
        },
      });
      return;
    }
    setPreview({ ...selection, state: { kind: 'loading' } });
    try {
      const file = await bridge.readDownload(projectId, download.id);
      if (!mounted.current || previewRequest.current !== attempt) return;
      setPreview({ ...selection, state: { kind: 'ready', file } });
    } catch (cause) {
      if (!mounted.current || previewRequest.current !== attempt) return;
      setPreview({
        ...selection,
        state: {
          kind: 'error',
          message:
            cause instanceof Error && cause.message
              ? cause.message
              : '无法读取下载文件，请重试或用系统应用打开。',
        },
      });
    }
  }

  async function command(action: DownloadAction, id?: string) {
    if (!state || !mounted.current || inFlight.current) return;
    inFlight.current = true;
    setPending({ action, id });
    setError('');
    try {
      await bridge.command(projectId, action, id);
      if (mounted.current && action !== 'cancel-download') {
        setNotice(
          action === 'reveal-download'
            ? '已在文件夹中显示下载文件。'
            : action === 'open-download'
              ? '已请求用系统应用打开下载文件。'
              : '已打开下载文件夹。',
        );
      }
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error && cause.message ? cause.message : '下载操作失败，请重试。',
        );
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(null);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant={activeCount ? 'secondary' : 'ghost'}
            className="desktop-browser-download-trigger"
            aria-label="浏览器下载"
            aria-describedby={summaryId}
            title={`浏览器下载：${summary}`}
          >
            <Download size={16} data-icon="inline-start" />
            {activeCount ? (
              <span aria-hidden="true">{activeCount > 99 ? '99+' : activeCount}</span>
            ) : error || lastResult === 'interrupted' ? (
              <CircleAlert size={16} data-icon="inline-end" aria-hidden="true" />
            ) : lastResult === 'completed' ? (
              <Check size={16} data-icon="inline-end" aria-hidden="true" />
            ) : null}
          </Button>
        </DialogTrigger>
        <DialogContent
          className={cn(
            'desktop-browser-downloads flex flex-col gap-4',
            preview && 'desktop-browser-downloads-preview',
          )}
        >
          <DialogHeader className="mb-0 min-w-0 shrink-0">
            {preview ? (
              <>
                <div className="flex min-w-0 items-center gap-3">
                  <Button
                    ref={focusPreviewBack}
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    onClick={returnToDownloads}
                  >
                    <ArrowLeft size={16} data-icon="inline-start" />
                    返回下载列表
                  </Button>
                  <DialogTitle className="truncate" title={downloadName(preview.download)}>
                    <bdi>{downloadName(preview.download)}</bdi>
                  </DialogTitle>
                </div>
                <DialogDescription>
                  文件预览 · {formatBytes(preview.download.receivedBytes)}
                </DialogDescription>
              </>
            ) : (
              <>
                <DialogTitle>下载</DialogTitle>
                <DialogDescription>
                  {activeCount ? `${activeCount} 个文件正在下载 · ` : ''}
                  当前项目的近期下载及文件保存位置。
                </DialogDescription>
              </>
            )}
          </DialogHeader>
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {notice}
          </span>
          <span className="sr-only" role="alert" aria-atomic="true">
            {failure}
          </span>
          <div
            className="desktop-browser-download-list-pane flex min-h-0 flex-1 flex-col gap-4"
            hidden={Boolean(preview)}
          >
            <section className="min-w-0 shrink-0" aria-label="下载保存位置">
              <h3 className="text-xs font-medium">下载文件夹</h3>
              <p
                className="mt-1 truncate text-xs text-muted-foreground"
                title={state?.downloadDirectory}
                dir="auto"
              >
                {state?.downloadDirectory || (state ? '下载目录暂不可用' : '正在读取保存位置…')}
              </p>
            </section>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
              {!state ? (
                <p className="py-6 text-sm text-muted-foreground" role="status">
                  正在读取下载记录…
                </p>
              ) : !downloads ? (
                <p className="py-6 text-sm text-muted-foreground">当前桌面版本尚未提供下载记录。</p>
              ) : downloads.length === 0 ? (
                <p className="py-6 text-sm text-muted-foreground">
                  还没有下载记录。从网页下载的文件会显示在这里。
                </p>
              ) : (
                <ul className="divide-y divide-border" aria-label="下载记录">
                  {downloads.map((download) => {
                    const name = downloadName(download);
                    return (
                      <li className="flex min-w-0 gap-3 py-3" key={download.id}>
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                          <File size={19} aria-hidden="true" />
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-2">
                          <div className="flex min-w-0 flex-col gap-1">
                            <h3 className="truncate text-sm font-semibold" title={name}>
                              <bdi>{name}</bdi>
                            </h3>
                            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
                              <span
                                className={cn(
                                  download.status === 'interrupted' && 'text-destructive',
                                )}
                              >
                                {statusLabels[download.status]}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="tabular-nums">
                                {download.status === 'progressing'
                                  ? downloadProgress(download)
                                  : `${download.status === 'completed' ? '' : '已接收 '}${formatBytes(download.receivedBytes)}`}
                              </span>
                            </p>
                          </div>
                          {download.status === 'progressing' ? (
                            <progress
                              className="desktop-browser-download-progress"
                              aria-label={`${name} 下载进度`}
                              aria-valuetext={downloadProgress(download)}
                              max={download.totalBytes > 0 ? download.totalBytes : undefined}
                              value={
                                download.totalBytes > 0
                                  ? Math.min(download.receivedBytes, download.totalBytes)
                                  : undefined
                              }
                            />
                          ) : null}
                          <DownloadPath path={download.path} />
                          {download.status === 'interrupted' ? (
                            <p className="text-xs text-destructive wrap-anywhere">
                              {download.error || '下载已中断，请返回网页重新下载。'}
                            </p>
                          ) : null}
                          {download.status === 'completed' ? (
                            <div className="desktop-browser-download-actions flex flex-wrap gap-1.5">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={Boolean(pending) || !download.path}
                                onClick={(event) => void openPreview(download, event.currentTarget)}
                              >
                                预览
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={Boolean(pending) || !download.path}
                                onClick={() => void command('open-download', download.id)}
                              >
                                {pending?.action === 'open-download' && pending.id === download.id
                                  ? '正在打开…'
                                  : '用系统应用打开'}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={Boolean(pending) || !download.path}
                                onClick={() => void command('reveal-download', download.id)}
                              >
                                {pending?.action === 'reveal-download' && pending.id === download.id
                                  ? '正在定位…'
                                  : '在文件夹中显示'}
                              </Button>
                            </div>
                          ) : download.status === 'progressing' ? (
                            <div className="desktop-browser-download-actions flex">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={Boolean(pending)}
                                onClick={() => void command('cancel-download', download.id)}
                              >
                                {pending?.action === 'cancel-download' && pending.id === download.id
                                  ? '正在取消…'
                                  : '取消下载'}
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
          {preview ? (
            <>
              <DownloadPath path={preview.download.path} />
              <div className="desktop-browser-download-preview min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain rounded-md border border-border">
                <BrowserDownloadPreview
                  key={preview.attempt}
                  state={preview.state}
                  onRetry={() => void openPreview(preview.download)}
                />
              </div>
            </>
          ) : null}
          {error ? (
            <p className="shrink-0 text-sm text-destructive wrap-anywhere" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter className="shrink-0">
            {preview ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  disabled={Boolean(pending)}
                  onClick={() => void command('open-download', preview.download.id)}
                >
                  {pending?.action === 'open-download' ? '正在打开…' : '用系统应用打开'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={Boolean(pending)}
                  onClick={() => void command('reveal-download', preview.download.id)}
                >
                  {pending?.action === 'reveal-download' ? '正在定位…' : '在文件夹中显示'}
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!state?.downloadDirectory || Boolean(pending)}
              onClick={() => void command('open-download-directory')}
            >
              <FolderOpen size={16} data-icon="inline-start" />
              {pending?.action === 'open-download-directory' ? '正在打开…' : '打开下载文件夹'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <span className="sr-only" id={summaryId}>
        {summary}
      </span>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {notice}
      </span>
      <span className="sr-only" role="alert" aria-atomic="true">
        {error || failure}
      </span>
    </>
  );
}
