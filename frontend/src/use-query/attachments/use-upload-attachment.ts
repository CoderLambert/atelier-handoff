/**
 * @file 校验并上传会话附件。
 * @implementation 原生选择、粘贴与拖入共用文件名、大小和 UTF-8 校验，经 API 写入后刷新所属会话。
 * @updated 2026-11-20T11:00:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { attachmentImageMime, maxImageAttachmentBytes, type Attachment } from '@shared/types';
import { api } from '@/api/client';
import { attachmentKeys } from './keys';

export const attachmentAccept =
  '.png,.jpg,.jpeg,.txt,.md,.json,.csv,.js,.ts,.jsx,.tsx,.css,.html,.yaml,.yml,.log,.py';
const textFile = /\.(txt|md|json|csv|js|ts|jsx|tsx|css|html|yaml|yml|log|py)$/i;

export async function uploadAttachment(sessionId: string, file: File): Promise<Attachment> {
  const image = attachmentImageMime(file.name);
  if (
    image
      ? file.size > maxImageAttachmentBytes
      : file.size > 1024 * 1024 || !textFile.test(file.name)
  )
    throw new Error('支持 5 MiB 以内的 PNG、JPEG 或 1 MiB 以内的 UTF-8 文本文件');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!image) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (bytes.includes(0)) throw new Error();
    } catch {
      throw new Error('请上传 UTF-8 文本文件');
    }
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  const result = await api<{ attachment: Attachment }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/attachments`,
    {
      method: 'POST',
      body: { name: file.name, mime: file.type || 'text/plain', contentBase64: btoa(binary) },
    },
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
