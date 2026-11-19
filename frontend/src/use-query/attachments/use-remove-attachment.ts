/**
 * @file 移除会话附件。
 * @implementation 与上传共享会话级串行作用域，完成后仅刷新所属会话快照。
 * @updated 2026-11-20T11:00:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { attachmentKeys } from './keys';

export function useRemoveAttachment(sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: attachmentKeys.operation(sessionId),
    scope: { id: attachmentKeys.scope(sessionId) },
    mutationFn: (attachmentId: string) =>
      api(
        `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`,
        { method: 'DELETE' },
      ),
    retry: false,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: attachmentKeys.snapshot(sessionId) });
    },
  });
}
