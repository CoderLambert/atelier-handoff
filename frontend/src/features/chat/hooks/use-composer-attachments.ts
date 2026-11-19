/**
 * @file 编排草稿附件的上传与移除。
 * @implementation 复用串行 query mutations，捕获发起操作时的草稿回调，保留逐项失败及会话隔离。
 * @updated 2026-11-20T11:00:00+08:00
 */
import { useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import type { Draft } from '@shared/types';
import { attachmentKeys } from '@/use-query/attachments/keys';
import { useUploadAttachment } from '@/use-query/attachments/use-upload-attachment';
import { useRemoveAttachment } from '@/use-query/attachments/use-remove-attachment';

export type DraftChange = (draft: Draft | ((previous: Draft) => Draft)) => void;
interface UploadEntry {
  id: string;
  name: string;
  error?: string;
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');

export function useComposerAttachments({
  sessionId,
  draft,
  onDraftChange,
  attachmentsAllowed,
  archived,
  submitting,
  onError,
}: {
  sessionId: string;
  draft: Draft;
  onDraftChange: DraftChange;
  attachmentsAllowed: boolean;
  archived: boolean;
  submitting: boolean;
  onError: (message: string) => void;
}) {
  const pendingOperations = useRef(0);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [removing, setRemoving] = useState<string[]>([]);
  const upload = useUploadAttachment(sessionId);
  const remove = useRemoveAttachment(sessionId);
  const mutationCount = useIsMutating({ mutationKey: attachmentKeys.operation(sessionId) });
  const busy = mutationCount > 0 || uploads.some((entry) => !entry.error) || removing.length > 0;
  const canUpload = attachmentsAllowed && !archived && !submitting && !busy;

  function queueUpload(files: FileList | File[] | null) {
    if (!files || !canUpload || pendingOperations.current) return;
    const available = Math.max(0, 20 - draft.attachmentIds.length);
    if (files.length > available) onError('每条任务最多附加 20 个附件，请移除部分附件后再上传。');
    for (const file of Array.from(files).slice(0, available)) {
      const entryId = crypto.randomUUID();
      pendingOperations.current += 1;
      setUploads((previous) => [...previous, { id: entryId, name: file.name }]);
      const changeDraft = onDraftChange;
      void upload
        .mutateAsync(file)
        .then(
          (attachment) => {
            changeDraft((previous) => ({
              ...previous,
              attachmentIds: [...new Set([...previous.attachmentIds, attachment.id])],
            }));
            setUploads((previous) => previous.filter((entry) => entry.id !== entryId));
          },
          (failure: unknown) => {
            setUploads((previous) =>
              previous.map((entry) =>
                entry.id === entryId ? { ...entry, error: errorText(failure) } : entry,
              ),
            );
          },
        )
        .finally(() => {
          pendingOperations.current -= 1;
        });
    }
  }

  function removeAttachment(attachmentId: string) {
    if (removing.includes(attachmentId) || archived || submitting) return;
    pendingOperations.current += 1;
    setRemoving((previous) => [...previous, attachmentId]);
    const changeDraft = onDraftChange;
    void remove
      .mutateAsync(attachmentId)
      .then(
        () => {
          changeDraft((previous) => ({
            ...previous,
            attachmentIds: previous.attachmentIds.filter((id) => id !== attachmentId),
          }));
        },
        (failure: unknown) => onError(`移除附件失败：${errorText(failure)}`),
      )
      .finally(() => {
        pendingOperations.current -= 1;
        setRemoving((previous) => previous.filter((id) => id !== attachmentId));
      });
  }

  return {
    uploads,
    removing,
    pendingOperations,
    busy,
    canUpload,
    queueUpload,
    removeAttachment,
    dismissUpload: (id: string) =>
      setUploads((previous) => previous.filter((entry) => entry.id !== id)),
  };
}
