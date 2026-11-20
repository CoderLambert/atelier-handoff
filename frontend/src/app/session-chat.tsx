/**
 * @file 连接会话聊天界面、运行模式与草稿操作。
 * @implementation 按会话协调模式保存、临时搜索上限与任务发送，限制只读智能体的可选模式。
 * @updated 2026-11-20T15:58:31+08:00
 */
import { useCallback, useMemo } from 'react';
import type { Draft } from '@shared/types';
import type { Snapshot } from '@/api/types';
import Chat from '@/features/chat';
import type { ComposerMode } from '@/features/chat/run-mode';
import { useSendSessionMessage } from '@/use-query/sessions/use-send-session-message';
import { readDraft, submitDraft, updateDraft } from './drafts';
import { actions, store, useWorkspace } from './store';

export default function SessionChat({
  snapshot,
  defaultModel,
  onSent,
  onError,
  onTrace,
  onStop,
  onRetry,
}: {
  snapshot: Snapshot;
  defaultModel: string;
  onSent: (id: string) => Promise<void>;
  onError: (message: string) => void;
  onTrace: (id: string) => void;
  onStop: (runId: string) => void;
  onRetry: (runId: string) => void;
}) {
  const { id, draft: serverDraft } = snapshot.session;
  const savedDraft = useWorkspace((state) => state.workspace.drafts[id]);
  const searchChargeLimit = useWorkspace((state) => state.workspace.searchChargeLimits[id]);
  const submitting = useWorkspace((state) => state.workspace.submitting[id] === true);
  const message = useSendSessionMessage();
  const fallback = useMemo(() => readDraft(id, serverDraft), [id, serverDraft]);
  const changeDraft = useCallback(
    (next: Draft | ((previous: Draft) => Draft)) => {
      updateDraft(id, next, serverDraft);
    },
    [id, serverDraft],
  );
  function changeMode(mode: ComposerMode) {
    if (store.getState().workspace.submitting[id]) return;
    if (snapshot.agent?.mode === 'readonly' && mode !== 'readonly') return;
    if (mode !== 'automatic') store.dispatch(actions.setSearchChargeLimit({ id }));
    updateDraft(
      id,
      (previous) => ({
        ...previous,
        mode: mode === 'automatic' ? 'edit' : mode,
        approvalMode: mode === 'automatic' ? 'automatic' : undefined,
      }),
      serverDraft,
      true,
    );
  }
  async function send() {
    try {
      await submitDraft(
        id,
        serverDraft,
        message.mutateAsync,
        snapshot.agent?.mode === 'readonly',
        defaultModel || undefined,
      );
    } catch (error) {
      onError(`发送未确认，草稿和运行模式已保留。${(error as Error).message}`);
      return;
    }
    try {
      await onSent(id);
    } catch (error) {
      onError(`任务已发送，刷新会话失败。${(error as Error).message}`);
    }
  }
  return (
    <Chat
      snapshot={snapshot}
      draft={savedDraft ?? fallback}
      defaultModel={defaultModel}
      onModelChange={(model) => {
        if (store.getState().workspace.submitting[id]) return;
        updateDraft(id, (previous) => ({ ...previous, model }), serverDraft, true);
      }}
      searchChargeLimit={searchChargeLimit}
      onModeChange={changeMode}
      onSearchChargeChange={(value) => {
        if (store.getState().workspace.submitting[id] || snapshot.agent?.mode === 'readonly')
          return;
        store.dispatch(actions.setSearchChargeLimit({ id, value }));
      }}
      onDraftChange={changeDraft}
      onSend={send}
      onStop={onStop}
      onRetry={onRetry}
      onTrace={onTrace}
      submitting={submitting}
    />
  );
}
