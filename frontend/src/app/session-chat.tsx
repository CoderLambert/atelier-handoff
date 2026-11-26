/**
 * @file 连接会话输入、运行偏好与消息发送。
 * @implementation 按会话提供草稿与按需读取入口，传递输入焦点请求及完成回执，将快捷插入投递到发送回执指定的队列项。
 * @updated 2026-11-27T01:26:00+08:00
 */
import { useUiTranslation, translateError } from '@/i18n';
import { useCallback, useEffect, useMemo } from 'react';
import type { Draft } from '@shared/types';
import type { Snapshot } from '@/api/types';
import Chat from '@/features/chat';
import { withComposerMode, type ComposerMode } from '@/features/chat/run-mode';
import { useInsertQueuedMessage } from '@/use-query/sessions/use-insert-queued-message';
import { useSendSessionMessage } from '@/use-query/sessions/use-send-session-message';
import { readDraft, submitDraft, updateDraft } from './drafts';
import { actions, store, useWorkspace } from './store';

export default function SessionChat({
  snapshot,
  defaultModel,
  nativeExecution = false,
  onOpenLink,
  onSent,
  onError,
  onTrace,
  onStop,
  onRetry,
  onForkMessage,
  onRewindMessage,
  forkingMessageId,
  focusMessageId,
  inputFocusRequest,
  onInputFocused,
}: {
  snapshot: Snapshot;
  defaultModel: string;
  nativeExecution?: boolean;
  onOpenLink?: (url: string, destination: 'internal' | 'external') => Promise<void>;
  onSent: (id: string) => Promise<void>;
  onError: (message: string) => void;
  onTrace: (id: string) => void;
  onStop: (runId: string) => void;
  onRetry: (runId: string) => void;
  onForkMessage?: (messageId: string) => void;
  onRewindMessage?: (messageId: string, expectedHeadId: string) => Promise<void>;
  forkingMessageId?: string;
  focusMessageId?: string;
  inputFocusRequest?: number;
  onInputFocused?: (request: number) => void;
}) {
  const { t } = useUiTranslation('chat');
  const { id, draft: serverDraft } = snapshot.session;
  useEffect(() => {
    if (!focusMessageId) return;
    const row = document.querySelector<HTMLElement>(
      `[data-session-id="${CSS.escape(id)}"] [data-message-id="${CSS.escape(focusMessageId)}"]`,
    );
    if (row) {
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'center' });
    }
  }, [focusMessageId, id]);
  const savedDraft = useWorkspace((state) => state.workspace.drafts[id]);
  const submitting = useWorkspace((state) => state.workspace.submitting[id] === true);
  const message = useSendSessionMessage();
  const insert = useInsertQueuedMessage(id);
  const getDraft = useCallback(() => readDraft(id, serverDraft), [id, serverDraft]);
  const fallback = useMemo(getDraft, [getDraft]);
  const nativeAvailable = nativeExecution && !snapshot.agent && !snapshot.session.agentRevisionId;
  const changeDraft = useCallback(
    (next: Draft | ((previous: Draft) => Draft), immediate = false) => {
      updateDraft(
        id,
        (previous) => {
          const draft = typeof next === 'function' ? next(previous) : next;
          return draft.executionPreference === 'native-v1' && !nativeAvailable
            ? { ...draft, executionPreference: 'project-v1' }
            : draft;
        },
        serverDraft,
        immediate,
      );
    },
    [id, serverDraft, nativeAvailable],
  );
  function changeMode(mode: ComposerMode) {
    if (store.getState().workspace.submitting[id]) return;
    if (snapshot.agent?.mode === 'readonly' && mode !== 'readonly') return;
    if (mode === 'native' && !nativeAvailable) return;
    if (mode !== 'automatic') store.dispatch(actions.setSearchChargeLimit({ id }));
    updateDraft(id, (previous) => withComposerMode(previous, mode), serverDraft, true);
  }
  async function send(insertIntoRunId?: string) {
    let result;
    try {
      result = await submitDraft(
        id,
        serverDraft,
        message.mutateAsync,
        snapshot.agent?.mode === 'readonly',
        defaultModel || undefined,
        nativeAvailable,
      );
    } catch (error) {
      if (snapshot.workspace) void onSent(id).catch(() => {});
      onError(translateError(error, t('session.sendUnconfirmed')));
      return;
    }
    if (!result) return;
    if (insertIntoRunId && result.queuedMessage?.insertion === 'priority') {
      onError(t('session.insertRequiresStop'));
    } else if (insertIntoRunId && result.queuedMessage?.insertion === 'live') {
      try {
        await insert.mutateAsync({
          itemId: result.queuedMessage.id,
          runId: insertIntoRunId,
          mode: 'live',
        });
      } catch {
        onError(t('session.insertUnconfirmed'));
      }
    }
    try {
      await onSent(id);
    } catch (error) {
      onError(translateError(error, t('session.refreshFailed')));
    }
  }
  return (
    <Chat
      inputFocusRequest={inputFocusRequest}
      onInputFocused={onInputFocused}
      snapshot={snapshot}
      draft={savedDraft ?? fallback}
      getDraft={getDraft}
      defaultModel={defaultModel}
      nativeExecution={nativeAvailable}
      onOpenLink={onOpenLink}
      onModelChange={(model) => {
        if (store.getState().workspace.submitting[id]) return;
        changeDraft(
          (previous) => ({
            ...previous,
            model,
            effort: previous.model === model ? previous.effort : undefined,
          }),
          true,
        );
      }}
      onEffortChange={(effort) => {
        if (store.getState().workspace.submitting[id]) return;
        changeDraft((previous) => ({ ...previous, effort }), true);
      }}
      onModeChange={changeMode}
      onDraftChange={changeDraft}
      onSend={send}
      onStop={onStop}
      onRetry={onRetry}
      onTrace={onTrace}
      onForkMessage={onForkMessage}
      onRewindMessage={onRewindMessage}
      forkingMessageId={forkingMessageId}
      submitting={submitting}
    />
  );
}
