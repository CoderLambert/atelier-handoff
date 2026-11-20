/**
 * @file 查询会话 DOCX 附件的已解析文本预览。
 * @implementation 使用独立操作和查询键读取服务端有界文本，校验响应并传递取消信号，保留原附件身份。
 * @updated 2026-11-21T00:00:00+08:00
 */
import { queryOptions, skipToken, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { Attachment } from '@shared/types';
import { api } from '@/api/client';
import { attachmentKeys } from './keys';
import { attachmentPreviewKind } from './use-attachment-content';

const documentPreview = z.object({ text: z.string() });

export function attachmentDocumentPreviewOptions(attachment: Attachment, open: boolean) {
  const readable = attachmentPreviewKind(attachment) === 'document-text';
  return queryOptions({
    queryKey: attachmentKeys.documentPreview(attachment.sessionId, attachment.id),
    enabled: open && !attachment.removed && readable,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    queryFn: readable
      ? async ({ signal }) =>
          documentPreview.parse(
            await api<unknown>(
              `/api/sessions/${encodeURIComponent(attachment.sessionId)}/attachments/${encodeURIComponent(attachment.id)}/document-preview`,
              { signal },
            ),
          )
      : skipToken,
  });
}

export function useAttachmentDocumentPreview(attachment: Attachment, open: boolean) {
  return useQuery(attachmentDocumentPreviewOptions(attachment, open));
}
