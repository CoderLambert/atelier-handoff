import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ErrorNotice, Loading, errorMessage, formatBytes } from '@/features/inspector/shared';
import type { Attachment } from '@shared/types';

const FilePreview = lazy(() => import('@/components/file-preview'));

export function AttachmentPreview({
  attachment,
  children,
}: {
  attachment: Attachment;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { id, sessionId, name, size } = attachment;
  const content = useQuery({
    queryKey: ['attachment-preview', sessionId, id],
    enabled: open && !attachment.removed,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    queryFn: ({ signal }) =>
      api<{ text: string }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}/content`,
        { signal },
      ),
  });

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
      <DialogContent className="attachment-preview-dialog flex flex-col overflow-hidden">
        <DialogTitle className="truncate pe-8" title={name}>
          {name}
        </DialogTitle>
        <DialogDescription className="sr-only">会话附件 · {formatBytes(size)}</DialogDescription>
        <div className="min-h-0 overflow-auto">
          {attachment.removed ? (
            <p>附件已移除。</p>
          ) : content.error ? (
            <ErrorNotice
              message={errorMessage(content.error)}
              onRetry={() => void content.refetch()}
            />
          ) : content.isFetching || !content.data ? (
            <Loading>正在读取附件…</Loading>
          ) : (
            <Suspense fallback={<Loading>正在加载预览…</Loading>}>
              <FilePreview name={name} text={content.data.text} />
            </Suspense>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
