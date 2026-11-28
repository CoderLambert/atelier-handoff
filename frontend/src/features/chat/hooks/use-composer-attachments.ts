/**
 * @file 编排草稿附件的上传与移除。
 * @implementation 新会话附件先校验并暂存在窗口。已有会话串行上传或移除附件，逐项处理失败并保留发起操作时的会话归属。
 * @updated 2026-11-28T15:51:00+08:00
 */
import { useUiTranslation, translateError } from '@/i18n';
import { useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import type { Draft } from '@shared/types';
import { attachmentKeys } from '@/use-query/attachments/keys';
import {
  AttachmentValidationError,
  useUploadAttachment,
  validateAttachment,
} from '@/use-query/attachments/use-upload-attachment';
import { useRemoveAttachment } from '@/use-query/attachments/use-remove-attachment';
import { removeStagedAttachment, stageAttachment } from '../staged-attachments';

export type AttachmentActionError = { type: 'limit' } | { type: 'remove'; cause: unknown };
export type DraftChange = (draft: Draft | ((previous: Draft) => Draft)) => void;
interface UploadEntry {
  id: string;
  name: string;
  failure?: { cause: unknown };
}

export function useComposerAttachments({
  sessionId,
  draft,
  newSession,
  onDraftChange,
  attachmentsAllowed,
  archived,
  submitting,
  onError,
}: {
  sessionId: string;
  draft: Draft;
  newSession: boolean;
  onDraftChange: DraftChange;
  attachmentsAllowed: boolean;
  archived: boolean;
  submitting: boolean;
  onError: (error: AttachmentActionError) => void;
}) {
  const { t } = useUiTranslation('chat');
  const pendingOperations = useRef(0);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [removing, setRemoving] = useState<string[]>([]);
  const upload = useUploadAttachment(sessionId);
  const remove = useRemoveAttachment(sessionId);
  const mutationCount = useIsMutating({ mutationKey: attachmentKeys.operation(sessionId) });
  const busy = mutationCount > 0 || uploads.some((entry) => !entry.failure) || removing.length > 0;
  const canUpload = attachmentsAllowed && !archived && !submitting && !busy;

  function queueUpload(files: FileList | File[] | null) {
    if (!files || !canUpload || pendingOperations.current) return;
    const available = Math.max(0, 20 - draft.attachmentIds.length);
    if (files.length > available) onError({ type: 'limit' });
    for (const file of Array.from(files).slice(0, available)) {
      const entryId = crypto.randomUUID();
      pendingOperations.current += 1;
      setUploads((previous) => [...previous, { id: entryId, name: file.name }]);
      const changeDraft = onDraftChange;
      const add = newSession
        ? validateAttachment(file).then(() => stageAttachment(sessionId, file))
        : upload.mutateAsync(file).then(({ id }) => id);
      void add
        .then(
          (id) => {
            changeDraft((previous) => ({
              ...previous,
              attachmentIds: [...new Set([...previous.attachmentIds, id])],
            }));
            setUploads((previous) => previous.filter((entry) => entry.id !== entryId));
          },
          (failure: unknown) => {
            setUploads((previous) =>
              previous.map((entry) =>
                entry.id === entryId ? { ...entry, failure: { cause: failure } } : entry,
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
    if (newSession) {
      removeStagedAttachment(sessionId, attachmentId);
      onDraftChange((previous) => ({
        ...previous,
        attachmentIds: previous.attachmentIds.filter((id) => id !== attachmentId),
      }));
      return;
    }
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
        (failure: unknown) => onError({ type: 'remove', cause: failure }),
      )
      .finally(() => {
        pendingOperations.current -= 1;
        setRemoving((previous) => previous.filter((id) => id !== attachmentId));
      });
  }

  return {
    uploads: uploads.map(({ failure, ...entry }) => ({
      ...entry,
      error: failure
        ? failure.cause instanceof AttachmentValidationError
          ? t(failure.cause.translationKey)
          : translateError(failure.cause, t('attachment.uploadFailed'))
        : undefined,
    })),
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
