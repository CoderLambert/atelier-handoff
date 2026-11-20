/**
 * @file 提供原生浏览器下载入口、进度与保存位置列表。
 * @implementation 消费项目下载快照，使用 Dialog 展示记录，通过类型化桥接请求取消或定位，并播报完成和失败。
 * @updated 2026-11-20T18:19:08+08:00
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Check, CircleAlert, Download, FolderOpen } from 'lucide-react';
import type {
  DesktopBrowserAction,
  DesktopBrowserBridge,
  DesktopBrowserDownload,
  DesktopBrowserState,
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

type DownloadAction = Extract<
  DesktopBrowserAction,
  'reveal-download' | 'cancel-download' | 'open-download-directory'
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

function downloadProgress(download: DesktopBrowserDownload) {
  const received = formatBytes(download.receivedBytes);
  if (download.totalBytes <= 0) return `已接收 ${received}，总大小未知`;
  const percent = Math.min(100, Math.floor((download.receivedBytes / download.totalBytes) * 100));
  return `${percent}% · ${received} / ${formatBytes(download.totalBytes)}`;
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
        .map((download) => `${download.filename}：${statusLabels[download.status]}。`)
        .join(' '),
    );
    setFailure(
      finished
        .filter((download) => download.status === 'interrupted')
        .map(
          (download) =>
            `${download.filename}：下载失败。${download.error || '请返回网页重新下载。'}`,
        )
        .join(' '),
    );
    setLastResult(
      finished.some((download) => download.status === 'interrupted')
        ? 'interrupted'
        : finished[0]?.status,
    );
  }, [downloads]);

  async function command(action: DownloadAction, id?: string) {
    if (!state || !mounted.current || inFlight.current) return;
    inFlight.current = true;
    setPending({ action, id });
    setError('');
    try {
      await bridge.command(projectId, action, id);
      if (mounted.current && action !== 'cancel-download') {
        setNotice(
          action === 'reveal-download' ? '已在文件夹中显示下载文件。' : '已打开下载文件夹。',
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
      <Dialog>
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
        <DialogContent className="desktop-browser-downloads flex flex-col gap-4">
          <DialogHeader className="mb-0 shrink-0">
            <DialogTitle>下载</DialogTitle>
            <DialogDescription>当前项目的近期下载及文件保存位置。</DialogDescription>
          </DialogHeader>
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {notice}
          </span>
          <span className="sr-only" role="alert" aria-atomic="true">
            {failure}
          </span>
          <section
            className="flex min-w-0 shrink-0 flex-col gap-1 text-sm"
            aria-label="下载保存位置"
          >
            <h3 className="font-semibold">下载文件夹</h3>
            <p className="text-muted-foreground wrap-anywhere" dir="auto">
              {state?.downloadDirectory || (state ? '下载目录暂不可用' : '正在读取保存位置…')}
            </p>
          </section>
          <div className="min-h-0 min-w-0 overflow-y-auto overscroll-contain">
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
                {downloads.map((download) => (
                  <li className="flex min-w-0 flex-col gap-3 py-4" key={download.id}>
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <h3 className="min-w-0 text-sm font-semibold wrap-anywhere">
                        {download.filename}
                      </h3>
                      <span
                        className={cn(
                          'shrink-0 text-xs text-muted-foreground',
                          download.status === 'interrupted' && 'text-destructive',
                        )}
                      >
                        {statusLabels[download.status]}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground wrap-anywhere" dir="auto">
                      保存路径：{download.path || '正在确定保存位置…'}
                    </p>
                    {download.status === 'progressing' ? (
                      <div className="flex flex-col gap-2">
                        <progress
                          className="desktop-browser-download-progress"
                          aria-label={`${download.filename} 下载进度`}
                          aria-valuetext={downloadProgress(download)}
                          max={download.totalBytes > 0 ? download.totalBytes : undefined}
                          value={
                            download.totalBytes > 0
                              ? Math.min(download.receivedBytes, download.totalBytes)
                              : undefined
                          }
                        />
                        <p className="text-xs text-muted-foreground">
                          {downloadProgress(download)}
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {download.status === 'completed' ? '文件大小' : '已接收'}：
                        {formatBytes(download.receivedBytes)}
                      </p>
                    )}
                    {download.status === 'interrupted' ? (
                      <p className="text-sm text-destructive wrap-anywhere">
                        {download.error || '下载已中断，请返回网页重新下载。'}
                      </p>
                    ) : null}
                    {download.status === 'completed' || download.status === 'progressing' ? (
                      <div className="flex flex-wrap gap-2">
                        {download.status === 'completed' ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={Boolean(pending) || !download.path}
                            onClick={() => void command('reveal-download', download.id)}
                          >
                            <FolderOpen size={16} data-icon="inline-start" />
                            {pending?.action === 'reveal-download' && pending.id === download.id
                              ? '正在定位…'
                              : '在文件夹中显示'}
                          </Button>
                        ) : (
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
                        )}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error ? (
            <p className="shrink-0 text-sm text-destructive wrap-anywhere" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter className="shrink-0">
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
