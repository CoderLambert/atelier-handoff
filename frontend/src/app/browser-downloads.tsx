/**
 * @file 提供项目浏览器下载列表和文件操作入口。
 * @implementation 在 Dialog 中呈现进度和保存位置，通过类型化桥接读取预览、用系统应用打开或定位文件，并管理反馈与焦点。
 * @updated 2026-11-20T20:17:41+08:00
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
import type { browser } from '@shared/i18n/catalogs/browser';
import type { UiLocale } from '@shared/i18n/locale';
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
import { getTranslator, translateError, useUiTranslation } from '@/i18n';
import { formatBytes } from '@/utils/format';
import {
  BrowserDownloadPreview,
  type BrowserDownloadPreviewState,
} from './browser-download-preview';

type DownloadAction = Extract<
  DesktopBrowserAction,
  'reveal-download' | 'cancel-download' | 'open-download-directory' | 'open-download'
>;
type DownloadNotice =
  | { kind: 'finished'; downloads: DesktopBrowserDownload[] }
  | { kind: 'command'; action: Exclude<DownloadAction, 'cancel-download'> };
const statusKeys = {
  progressing: 'downloads.status.progressing',
  completed: 'downloads.status.completed',
  cancelled: 'downloads.status.cancelled',
  interrupted: 'downloads.status.interrupted',
} as const satisfies Record<DesktopBrowserDownload['status'], keyof typeof browser>;
const commandNoticeKeys = {
  'reveal-download': 'downloads.revealed',
  'open-download': 'downloads.openRequested',
  'open-download-directory': 'downloads.directoryOpened',
} as const satisfies Record<Exclude<DownloadAction, 'cancel-download'>, keyof typeof browser>;

function downloadBytes(bytes: number, locale: UiLocale) {
  return formatBytes(bytes, locale, true);
}

function downloadName(download: DesktopBrowserDownload) {
  return download.path.split(/[\\/]/).at(-1) || download.filename;
}

function downloadProgress(download: DesktopBrowserDownload, locale: UiLocale) {
  const t = getTranslator('browser');
  const received = downloadBytes(download.receivedBytes, locale);
  if (download.totalBytes <= 0) return t('downloads.progressUnknown', { received });
  const percent = Math.min(100, Math.floor((download.receivedBytes / download.totalBytes) * 100));
  return t('downloads.progress', {
    percent: (percent / 100).toLocaleString(locale, { style: 'percent', maximumFractionDigits: 0 }),
    received,
    total: downloadBytes(download.totalBytes, locale),
  });
}

function DownloadPath({ path }: { path: string }) {
  const { t } = useUiTranslation('browser');
  const label = path || t('downloads.pathPending');
  return (
    <details className="min-w-0 text-xs text-muted-foreground">
      <summary className="cursor-pointer truncate" title={label}>
        {t('downloads.pathLabel')}
        <bdi>{label}</bdi>
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
  const { t, locale } = useUiTranslation('browser');
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
  const [actionError, setActionError] = useState<{ cause: unknown } | null>(null);
  const [lastNotice, setNotice] = useState<DownloadNotice | null>(null);
  const [failedDownloads, setFailures] = useState<DesktopBrowserDownload[]>([]);
  const [lastResult, setLastResult] = useState<DesktopBrowserDownload['status']>();
  const error = actionError ? translateError(actionError.cause, t('downloads.actionFailed')) : '';
  const notice = lastNotice
    ? lastNotice.kind === 'command'
      ? t(commandNoticeKeys[lastNotice.action])
      : lastNotice.downloads
          .map((download) =>
            t('downloads.finished', {
              name: downloadName(download),
              status: t(statusKeys[download.status]),
            }),
          )
          .join(' ')
    : '';
  const failure = failedDownloads
    .map((download) =>
      t('downloads.failed', {
        name: downloadName(download),
        error: translateError(download.error, t('downloads.retryDownload')),
      }),
    )
    .join(' ');
  const summary = activeCount
    ? t('downloads.activeSummary', {
        count: activeCount,
        formattedCount: activeCount.toLocaleString(locale),
      })
    : error || failure || notice || t('downloads.summary');

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
    setNotice({
      kind: 'finished',
      downloads: finished.filter((download) => download.status !== 'interrupted'),
    });
    setFailures(finished.filter((download) => download.status === 'interrupted'));
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
    setActionError(null);
    if (!browserDownloadPreviewMime(name)) {
      setPreview({
        ...selection,
        state: { kind: 'unavailable', reason: 'unsupportedFormat' },
      });
      return;
    }
    if (Math.max(download.receivedBytes, download.totalBytes) > browserDownloadPreviewMaxBytes) {
      setPreview({
        ...selection,
        state: { kind: 'unavailable', reason: 'tooLarge' },
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
      setPreview({ ...selection, state: { kind: 'error', error: cause } });
    }
  }

  async function command(action: DownloadAction, id?: string) {
    if (!state || !mounted.current || inFlight.current) return;
    inFlight.current = true;
    setPending({ action, id });
    setActionError(null);
    try {
      await bridge.command(projectId, action, id);
      if (mounted.current && action !== 'cancel-download') {
        setNotice({ kind: 'command', action });
      }
    } catch (cause) {
      if (mounted.current) {
        setActionError({ cause });
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
            size="xs"
            variant={activeCount ? 'secondary' : 'ghost'}
            className="desktop-browser-download-trigger"
            aria-label={t('downloads.label')}
            aria-describedby={summaryId}
            title={t('downloads.triggerTitle', { summary })}
          >
            <Download data-icon="inline-start" aria-hidden="true" />
            {activeCount ? (
              <span aria-hidden="true">
                {activeCount > 99
                  ? t('downloads.badgeOverflow', { limit: (99).toLocaleString(locale) })
                  : activeCount.toLocaleString(locale)}
              </span>
            ) : error || lastResult === 'interrupted' ? (
              <CircleAlert data-icon="inline-end" aria-hidden="true" />
            ) : lastResult === 'completed' ? (
              <Check data-icon="inline-end" aria-hidden="true" />
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
                    <ArrowLeft data-icon="inline-start" aria-hidden="true" />
                    {t('downloads.back')}
                  </Button>
                  <DialogTitle className="truncate" title={downloadName(preview.download)}>
                    <bdi>{downloadName(preview.download)}</bdi>
                  </DialogTitle>
                </div>
                <DialogDescription>
                  {t('downloads.previewSize', {
                    size: downloadBytes(preview.download.receivedBytes, locale),
                  })}
                </DialogDescription>
              </>
            ) : (
              <>
                <DialogTitle>{t('downloads.title')}</DialogTitle>
                <DialogDescription>
                  {activeCount
                    ? t('downloads.activeDescription', {
                        count: activeCount,
                        formattedCount: activeCount.toLocaleString(locale),
                      })
                    : t('downloads.description')}
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
            <section className="min-w-0 shrink-0" aria-label={t('downloads.locationLabel')}>
              <h3 className="text-xs font-medium">{t('downloads.directory')}</h3>
              <p
                className="mt-1 truncate text-xs text-muted-foreground"
                title={state?.downloadDirectory}
                dir="auto"
              >
                {state?.downloadDirectory ||
                  t(state ? 'downloads.directoryUnavailable' : 'downloads.readingLocation')}
              </p>
            </section>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
              {!state ? (
                <p className="py-6 text-sm text-muted-foreground" role="status">
                  {t('downloads.loading')}
                </p>
              ) : !downloads ? (
                <p className="py-6 text-sm text-muted-foreground">{t('downloads.unsupported')}</p>
              ) : downloads.length === 0 ? (
                <p className="py-6 text-sm text-muted-foreground">{t('downloads.empty')}</p>
              ) : (
                <ul className="divide-y divide-border" aria-label={t('downloads.historyLabel')}>
                  {downloads.map((download) => {
                    const name = downloadName(download);
                    return (
                      <li className="flex min-w-0 gap-3 py-3" key={download.id}>
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                          <File className="size-(--ui-icon-size-emphasis)" aria-hidden="true" />
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
                                {t(statusKeys[download.status])}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="tabular-nums">
                                {download.status === 'progressing'
                                  ? downloadProgress(download, locale)
                                  : download.status === 'completed'
                                    ? downloadBytes(download.receivedBytes, locale)
                                    : t('downloads.received', {
                                        size: downloadBytes(download.receivedBytes, locale),
                                      })}
                              </span>
                            </p>
                          </div>
                          {download.status === 'progressing' ? (
                            <progress
                              className="desktop-browser-download-progress"
                              aria-label={t('downloads.progressLabel', { name })}
                              aria-valuetext={downloadProgress(download, locale)}
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
                              {translateError(download.error, t('downloads.interrupted'))}
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
                                {t('downloads.preview')}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={Boolean(pending) || !download.path}
                                onClick={() => void command('open-download', download.id)}
                              >
                                {t(
                                  pending?.action === 'open-download' && pending.id === download.id
                                    ? 'downloads.opening'
                                    : 'downloads.openWithApp',
                                )}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={Boolean(pending) || !download.path}
                                onClick={() => void command('reveal-download', download.id)}
                              >
                                {t(
                                  pending?.action === 'reveal-download' &&
                                    pending.id === download.id
                                    ? 'downloads.revealing'
                                    : 'downloads.reveal',
                                )}
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
                                {t(
                                  pending?.action === 'cancel-download' &&
                                    pending.id === download.id
                                    ? 'downloads.cancelling'
                                    : 'downloads.cancel',
                                )}
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
                  {t(
                    pending?.action === 'open-download'
                      ? 'downloads.opening'
                      : 'downloads.openWithApp',
                  )}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={Boolean(pending)}
                  onClick={() => void command('reveal-download', preview.download.id)}
                >
                  {t(
                    pending?.action === 'reveal-download'
                      ? 'downloads.revealing'
                      : 'downloads.reveal',
                  )}
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
              <FolderOpen data-icon="inline-start" aria-hidden="true" />
              {t(
                pending?.action === 'open-download-directory'
                  ? 'downloads.opening'
                  : 'downloads.openDirectory',
              )}
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
