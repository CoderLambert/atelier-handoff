/**
 * @file 查询会话附件的文本或二进制预览内容。
 * @implementation 依据共享文档分类选择原件字节或 JSON 文本；大表格跳过读取，查询绑定会话与附件并传递取消信号。
 * @updated 2026-11-21T00:00:00+08:00
 */
import { queryOptions, skipToken, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { Attachment } from '@shared/types';
import {
  documentPreviewBytes,
  isDocumentAttachmentMime,
  spreadsheetAttachmentMime,
} from '@shared/document-attachments';
import { api, apiBytes } from '@/api/client';
import { attachmentKeys } from './keys';

export type AttachmentPreviewKind = 'image' | 'text' | 'binary' | 'document-text' | 'download';
export type AttachmentContent =
  { kind: 'text'; text: string } | { kind: 'binary'; bytes: ArrayBuffer };
const textContent = z.object({ text: z.string() });

export function attachmentPreviewKind({ mime, size }: Attachment): AttachmentPreviewKind {
  if (mime === 'image/png' || mime === 'image/jpeg') return 'image';
  if (!isDocumentAttachmentMime(mime)) return 'text';
  if (spreadsheetAttachmentMime(mime)) return size > documentPreviewBytes ? 'download' : 'binary';
  return mime === 'application/pdf' ? 'binary' : 'document-text';
}

export function attachmentContentUrl({ sessionId, id }: Pick<Attachment, 'sessionId' | 'id'>) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}/content`;
}

export function attachmentDownloadUrl({ sessionId, id }: Pick<Attachment, 'sessionId' | 'id'>) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}/download`;
}

export function attachmentContentOptions(attachment: Attachment, open: boolean) {
  const kind = attachmentPreviewKind(attachment);
  const readable = kind === 'text' || kind === 'binary';
  return queryOptions({
    queryKey: attachmentKeys.content(attachment.sessionId, attachment.id),
    enabled: open && !attachment.removed && readable,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    queryFn: readable
      ? async ({ signal }): Promise<AttachmentContent> => {
          const path = attachmentContentUrl(attachment);
          if (kind === 'binary') return { kind, bytes: await apiBytes(path, { signal }) };
          const result = textContent.parse(await api<unknown>(path, { signal }));
          return { kind: 'text', text: result.text };
        }
      : skipToken,
  });
}

export function useAttachmentContent(attachment: Attachment, open: boolean) {
  return useQuery(attachmentContentOptions(attachment, open));
}
