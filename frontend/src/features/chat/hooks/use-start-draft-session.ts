/**
 * @file 发送新会话的第一条消息。
 * @implementation 复用固定会话编号、逐个提交本地附件，并将结果交给常规消息发送接口。
 * @updated 2026-11-28T15:43:00+08:00
 */
import { useCallback } from 'react';
import { getTranslator } from '@/i18n';
import { useUploadAttachment } from '@/use-query/attachments/use-upload-attachment';
import { useCreateSession } from '@/use-query/sessions/use-create-session';
import {
  useSendSessionMessage,
  type SendSessionMessage,
} from '@/use-query/sessions/use-send-session-message';
import { stagedAttachment } from '../staged-attachments';

export function useStartDraftSession(projectId: string, draftId: string) {
  const { mutateAsync: create } = useCreateSession();
  const { mutateAsync: upload } = useUploadAttachment(draftId);
  const { mutateAsync: send } = useSendSessionMessage();
  return useCallback<SendSessionMessage>(
    async ({ sessionId: localId, body }) => {
      const attachments = body.attachmentIds.map((id) => {
        const entry = stagedAttachment(localId, id);
        if (!entry) throw new Error(getTranslator('chat')('attachment.uploadFailed'));
        return entry;
      });
      const { session } = await create({ projectId, draftId });
      const attachmentIds: string[] = [];
      for (const entry of attachments) {
        entry.uploadedId ??= (await upload(entry.file)).id;
        attachmentIds.push(entry.uploadedId);
      }
      return send({ sessionId: session.id, body: { ...body, attachmentIds } });
    },
    [create, draftId, projectId, send, upload],
  );
}
