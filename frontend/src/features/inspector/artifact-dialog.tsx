import { Maximize, Minimize } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Artifact } from '@shared/types';
import {
  ErrorNotice,
  Icon,
  Loading,
  actionLinkClass,
  formatBytes,
  formatDate,
  preClass,
  useResource,
} from './shared';

type ArtifactContent = {
  artifact: Artifact;
  text: string;
  previewable: boolean;
  previewKind: 'html' | 'text';
};
export default function ArtifactDialog({
  artifact,
  onOpenChange,
}: {
  artifact: Artifact;
  onOpenChange: (open: boolean) => void;
}) {
  const [source, setSource] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const path = `/api/artifacts/${encodeURIComponent(artifact.id)}`;
  const content = useResource<ArtifactContent>(`${path}/content`, [
    'artifacts',
    artifact.id,
    'content',
  ]);
  const item = content.data?.artifact ?? artifact;
  const html = content.data?.previewKind === 'html';
  const previewing = html && !source && content.data?.previewable === true;
  const expanded = fullscreen && previewing;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className={`flex max-h-[94dvh] w-[calc(100%-2rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl${expanded ? ' artifact-dialog-fullscreen' : ''}`}
        onEscapeKeyDown={(event) => {
          if (expanded) {
            event.preventDefault();
            setFullscreen(false);
          }
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border px-5 py-5 sm:px-6">
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-6">
            <Icon name="file" className="size-4 shrink-0" />
            <span className="truncate" title={item.name}>
              {item.name}
            </span>
          </DialogTitle>
          <DialogDescription>
            {formatBytes(item.size)} · {item.mime} · {formatDate(item.createdAt)}
          </DialogDescription>
        </DialogHeader>
        <div
          className={
            expanded
              ? 'flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4'
              : 'min-h-0 space-y-3 overflow-y-auto p-4 sm:p-5'
          }
        >
          {content.loading && !content.data ? <Loading>正在读取交付物…</Loading> : null}
          {content.error ? <ErrorNotice message={content.error} onRetry={content.reload} /> : null}
          {content.data ? (
            <>
              {html ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">独立沙箱预览</p>
                  <div role="group" aria-label="交付物视图" className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      type="button"
                      variant={source ? 'ghost' : 'secondary'}
                      aria-pressed={!source}
                      onClick={() => setSource(false)}
                    >
                      预览
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      variant={source ? 'secondary' : 'ghost'}
                      aria-pressed={source}
                      onClick={() => {
                        setSource(true);
                        setFullscreen(false);
                      }}
                    >
                      源文件
                    </Button>
                    {previewing ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setFullscreen((current) => !current)}
                      >
                        {expanded ? <Minimize size={14} /> : <Maximize size={14} />}
                        {expanded ? '退出全屏' : '全屏'}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {previewing ? (
                <iframe
                  title={`${item.name} 的沙箱预览`}
                  src={`${path}/preview`}
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                  className={`w-full rounded-lg border border-border bg-white ${expanded ? 'min-h-0 flex-1' : 'h-[62dvh] min-h-64'}`}
                />
              ) : (
                <pre
                  tabIndex={0}
                  aria-label="交付物内容"
                  className={`${preClass} max-h-[62dvh] min-h-48`}
                >
                  {content.data.text || '（空文件）'}
                </pre>
              )}
            </>
          ) : null}
        </div>
        <DialogFooter className="shrink-0 border-t border-border bg-muted/20 px-5 py-4 sm:px-6">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          {content.data && !content.error ? (
            <a href={`${path}/download`} download={item.name} className={actionLinkClass}>
              <Icon name="download" />
              下载文件
            </a>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
