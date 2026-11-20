/**
 * @file 展示会话附件预览与原件下载。
 * @implementation 组合具名附件查询和 FileVista；DOCX 使用原附件 ID 的文本，大表格跳过内容读取，加载或解析失败保留下载及重试。
 * @updated 2026-11-21T00:00:00+08:00
 */
import { Component, lazy, Suspense, useCallback, useState, type ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { ErrorNotice, Loading, errorMessage, formatBytes } from '@/features/inspector/shared';
import {
  attachmentContentUrl,
  attachmentDownloadUrl,
  attachmentPreviewKind,
  useAttachmentContent,
} from '@/use-query/attachments/use-attachment-content';
import { useAttachmentDocumentPreview } from '@/use-query/attachments/use-attachment-document-preview';
import type { Attachment } from '@shared/types';

const FilePreview = lazy(() => import('@/components/file-preview'));

class PreviewBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function AttachmentContent({ attachment, open }: { attachment: Attachment; open: boolean }) {
  const kind = attachmentPreviewKind(attachment);
  const content = useAttachmentContent(attachment, open);
  const document = useAttachmentDocumentPreview(attachment, open);
  const [previewError, setPreviewError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const reportError = useCallback((error: Error) => setPreviewError(error.message), []);
  const query = kind === 'document-text' ? document : content;
  const retry = () => {
    setPreviewError(undefined);
    setAttempt((value) => value + 1);
    if (kind === 'text' || kind === 'binary' || kind === 'document-text') void query.refetch();
  };

  if (attachment.removed) return <p>附件已移除。</p>;
  if (kind === 'download') {
    return (
      <p className="p-4 text-sm text-muted-foreground" role="status">
        此表格超过 20 MiB，暂不支持应用内预览。请下载原件查看完整内容。
      </p>
    );
  }
  if (previewError || query.error) {
    return <ErrorNotice message={previewError ?? errorMessage(query.error)} onRetry={retry} />;
  }
  if (kind === 'image') {
    return (
      <img
        key={attempt}
        src={attachmentContentUrl(attachment)}
        alt={attachment.name}
        className="mx-auto block max-w-full object-contain"
        onError={() => setPreviewError('无法加载图片，请重试或下载原件。')}
      />
    );
  }
  const file =
    kind === 'document-text'
      ? document.data && { text: document.data.text }
      : content.data?.kind === 'binary'
        ? { bytes: content.data.bytes, mimeType: attachment.mime }
        : content.data && { text: content.data.text };
  if (query.isFetching || !file) return <Loading>正在读取附件…</Loading>;
  return (
    <PreviewBoundary
      key={attempt}
      fallback={<ErrorNotice message="文件预览未能加载，请重试或下载原件。" onRetry={retry} />}
    >
      <Suspense fallback={<Loading>正在加载预览…</Loading>}>
        <FilePreview id={attachment.id} name={attachment.name} {...file} onError={reportError} />
      </Suspense>
    </PreviewBoundary>
  );
}

export function AttachmentPreview({
  attachment,
  children,
}: {
  attachment: Attachment;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { id, sessionId, name, size } = attachment;
  const kind = attachmentPreviewKind(attachment);
  const document = kind === 'binary' || kind === 'document-text' || kind === 'download';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="attachment-preview-trigger"
          disabled={attachment.removed}
          aria-label={`预览附件 ${name}`}
        >
          {children}
        </button>
      </DialogTrigger>
      <DialogContent
        className={cn(
          'attachment-preview-dialog flex flex-col overflow-hidden',
          document && 'attachment-document-preview-dialog',
        )}
      >
        <DialogTitle className="shrink-0 truncate pe-8" title={name}>
          {name}
        </DialogTitle>
        <DialogDescription className="sr-only">会话附件 · {formatBytes(size)}</DialogDescription>
        {!attachment.removed ? (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {kind === 'document-text' ? 'Word 文档文本预览 · ' : ''}
              {formatBytes(size)}
            </p>
            <Button asChild variant="outline" size="sm">
              <a href={attachmentDownloadUrl(attachment)} download={name}>
                下载原件
              </a>
            </Button>
          </div>
        ) : null}
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <AttachmentContent key={`${sessionId}:${id}`} attachment={attachment} open={open} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
