/**
 * @file 在项目草稿页复用会话输入区。
 * @implementation 按项目恢复本地草稿，将首条消息成功的回执交还工作区导航并释放临时数据。
 * @updated 2026-11-28T15:43:00+08:00
 */
import { useCallback, useMemo, useState } from 'react';
import type { Project } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { useWorkspaceCache } from '@/use-query/workspace/use-workspace-cache';
import { useStartDraftSession } from '@/features/chat/hooks/use-start-draft-session';
import { clearStagedAttachments } from '@/features/chat/staged-attachments';
import { defaultNewSessionDraft, finishNewSessionDraft, newSessionDraftId } from './drafts';
import SessionChat from './session-chat';

export default function NewSessionChat({
  project,
  defaultModel,
  nativeExecution,
  onSent,
  onError,
}: {
  project: Project;
  defaultModel: string;
  nativeExecution: boolean;
  onSent: (projectId: string, id: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [draftId] = useState(() => newSessionDraftId(project.id));
  const localId = `new:${draftId}`;
  const cache = useWorkspaceCache();
  const sendDraft = useStartDraftSession(project.id, draftId);
  const snapshot = useMemo<Snapshot>(
    () => ({
      project,
      session: {
        id: localId,
        projectId: project.id,
        title: '',
        status: 'active',
        sdkSessionId: null,
        createdAt: '',
        updatedAt: '',
        draft: defaultNewSessionDraft(nativeExecution),
      },
      messages: [],
      runs: [],
      tools: [],
      permissions: [],
      artifacts: [],
      attachments: [],
      events: [],
      cursor: 0,
    }),
    [localId, nativeExecution, project],
  );
  const finish = useCallback(async () => {
    clearStagedAttachments(localId);
    await finishNewSessionDraft(project.id, draftId);
    cache.invalidateSessionLists();
    await onSent(project.id, draftId);
  }, [cache, draftId, localId, onSent, project.id]);

  return (
    <SessionChat
      snapshot={snapshot}
      defaultModel={defaultModel}
      nativeExecution={nativeExecution}
      sendDraft={sendDraft}
      onSent={finish}
      onError={onError}
    />
  );
}
