/**
 * @file 校验并上传会话附件。
 * @implementation 文档原件直接上传 File；图片和文本保留 JSON、大小和 UTF-8 校验，串行写入后刷新所属会话。
 * @updated 2026-11-21T00:00:00+08:00
 */
import { getTranslator } from '@/i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { attachmentImageMime, maxImageAttachmentBytes, type Attachment } from '@shared/types';
import { documentAttachmentMime } from '@shared/document-attachments';
import { api } from '@/api/client';
import { attachmentKeys } from './keys';

export class AttachmentValidationError extends Error {
  constructor(readonly translationKey: 'attachment.supportedFiles' | 'attachment.requireUtf8') {
    super(getTranslator('chat')(translationKey));
  }
}

export const attachmentAccept =
  '.png,.jpg,.jpeg,.xls,.xlsx,.pdf,.docx,.txt,.md,.json,.csv,.js,.ts,.jsx,.tsx,.css,.html,.yaml,.yml,.log,.py';
const textFile = /\.(txt|md|json|csv|js|ts|jsx|tsx|css|html|yaml|yml|log|py)$/i;

async function legacyAttachmentBody(file: File) {
  const image = attachmentImageMime(file.name);
  if (
    image
      ? file.size > maxImageAttachmentBytes
      : file.size > 1024 * 1024 || !textFile.test(file.name)
  )
    throw new AttachmentValidationError('attachment.supportedFiles');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!image) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (bytes.includes(0)) throw new Error();
    } catch {
      throw new AttachmentValidationError('attachment.requireUtf8');
    }
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return { name: file.name, mime: file.type || 'text/plain', contentBase64: btoa(binary) };
}

export async function uploadAttachment(sessionId: string, file: File): Promise<Attachment> {
  const document = documentAttachmentMime(file.name);
  const result = await api<{ attachment: Attachment }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/attachments${document ? `?name=${encodeURIComponent(file.name)}` : ''}`,
    document
      ? { method: 'POST', rawBody: file }
      : { method: 'POST', body: await legacyAttachmentBody(file) },
  );
  return result.attachment;
}

export function useUploadAttachment(sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: attachmentKeys.operation(sessionId),
    scope: { id: attachmentKeys.scope(sessionId) },
    mutationFn: (file: File) => uploadAttachment(sessionId, file),
    retry: false,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: attachmentKeys.snapshot(sessionId) });
    },
  });
}
