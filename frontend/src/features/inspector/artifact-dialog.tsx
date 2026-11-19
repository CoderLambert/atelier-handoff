import { Maximize, Minimize, X } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Artifact } from '@shared/types';
import { useArtifactContent } from '@/use-query/artifacts/use-artifact-content';
import type { ArtifactFileActionsState } from '@/use-query/artifacts/use-artifact-file-actions';
import { ArtifactFileActions } from './artifact-file-actions';
import { ErrorNotice, Loading, errorMessage, formatBytes, formatDate } from './shared';

const FilePreview = lazy(() => import('@/components/file-preview'));

export default function ArtifactDialog({
  artifact,
  fileActions,
  onOpenChange,
}: {
  artifact: Artifact;
  fileActions: ArtifactFileActionsState;
  onOpenChange: (open: boolean) => void;
}) {
  const [source, setSource] = useState(false);
  const [fullscreen, setFullscreen] = useState(true);
  const path = `/api/artifacts/${encodeURIComponent(artifact.id)}`;
  const content = useArtifactContent(artifact.id);
  const item = content.data?.artifact ?? artifact;
  const html = content.data ? content.data.previewKind === 'html' : /\.html?$/i.test(item.name);
  const pdf = !html && item.mime === 'application/pdf';
  const image = item.mime === 'image/png';
  const canExpand = html || pdf || image;
  const expanded = fullscreen && canExpand;
  const previewable = html && content.data?.previewable === true;
  const fullscreenLabel = expanded ? '退出全屏' : '全屏';

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={`artifact-dialog flex flex-col overflow-hidden${expanded ? ' artifact-dialog-fullscreen' : ''}`}
        onEscapeKeyDown={(event) => {
          if (expanded) {
            event.preventDefault();
            setFullscreen(false);
          }
        }}
      >
        <header className="artifact-preview-toolbar">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm" title={item.name}>
            {item.name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {formatBytes(item.size)} · {item.mime} · {formatDate(item.createdAt)}
          </DialogDescription>
          {previewable ? (
            <div role="group" aria-label="交付物视图" className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                variant={source ? 'ghost' : 'secondary'}
                aria-pressed={!source}
                onClick={() => setSource(false)}
              >
                预览
              </Button>
              <Button
                size="sm"
                variant={source ? 'secondary' : 'ghost'}
                aria-pressed={source}
                onClick={() => setSource(true)}
              >
                源文件
              </Button>
            </div>
          ) : null}
          <div className="flex shrink-0 items-center gap-1">
            {canExpand ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={fullscreenLabel}
                title={fullscreenLabel}
                onClick={() => setFullscreen((current) => !current)}
              >
                {expanded ? <Minimize size={16} /> : <Maximize size={16} />}
              </Button>
            ) : null}
            {content.data && !content.error ? (
              <ArtifactFileActions artifact={item} actions={fileActions} />
            ) : null}
            <Button asChild size="icon-sm" variant="ghost">
              <DialogClose aria-label="关闭预览" title="关闭预览">
                <X size={17} />
              </DialogClose>
            </Button>
          </div>
        </header>
        {fileActions.error ? (
          <p className="px-4 text-sm text-destructive" role="alert">
            {fileActions.error}
          </p>
        ) : null}
        {content.isFetching && !content.data ? (
          <div className="p-4">
            <Loading>正在读取交付物…</Loading>
          </div>
        ) : null}
        {content.error ? (
          <div className="p-4">
            <ErrorNotice
              message={errorMessage(content.error)}
              onRetry={() => void content.refetch()}
            />
          </div>
        ) : null}
        {content.data ? (
          previewable && !source ? (
            <iframe
              title={`${item.name} 的沙箱预览`}
              src={`${path}/preview`}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className={`block w-full border-0 bg-white ${expanded ? 'min-h-0 flex-1' : 'h-[62dvh] min-h-0'}`}
            />
          ) : (
            <div className={`min-h-0 overflow-auto ${expanded ? 'flex-1' : 'max-h-[75dvh]'}`}>
              <Suspense
                fallback={
                  <div className="p-4">
                    <Loading>正在加载预览…</Loading>
                  </div>
                }
              >
                {image ? (
                  <img
                    src={`${path}/preview`}
                    alt={item.name}
                    className="mx-auto block max-w-full object-contain"
                  />
                ) : pdf ? (
                  <FilePreview name={item.name} size={item.size} url={`${path}/download`} />
                ) : (
                  <FilePreview name={item.name} text={content.data.text} />
                )}
              </Suspense>
            </div>
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
