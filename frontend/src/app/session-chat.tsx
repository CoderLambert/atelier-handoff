/**
 * @file 连接会话输入、运行偏好、消息发送与会话级运行动作。
 * @implementation 按会话提供草稿与稳定的操作回调，内聚停止、重试与消息分支/回退请求，避免工作区外壳透传内联回调击穿对话记忆化。
 * @updated 2026-11-27T19:25:00+08:00
 */
import { useUiTranslation, translateError } from '@/i18n';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Draft, ReasoningEffort } from '@shared/types';
import type { Snapshot } from '@/api/types';
import Chat from '@/features/chat';
import { isNativeAvailable } from '@/features/chat/composer-policy';
import { withComposerMode, type ComposerMode } from '@/features/chat/run-mode';
import { useRetryRun } from '@/use-query/runs/use-retry-run';
import { useStopRun } from '@/use-query/runs/use-stop-run';
import { useForkSession } from '@/use-query/sessions/use-fork-session';
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
  onOpenSchedule,
  onOpenSession,
  getLocationPath,
  onStop,
  onRetry,
  onForkMessage,
  onRewindMessage,
  forkingMessageId,
  focusMessageId,
}: {
  snapshot: Snapshot;
  defaultModel: string;
  nativeExecution?: boolean;
  onOpenLink?: (url: string, destination: 'internal' | 'external') => Promise<void>;
  onSent: (id: string) => Promise<void>;
  onError: (message: string) => void;
  onTrace: (id: string) => void;
  onOpenSchedule?: (taskId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  getLocationPath?: () => string;
  onStop?: (runId: string) => void;
  onRetry?: (runId: string) => void;
  onForkMessage?: (messageId: string) => void;
  onRewindMessage?: (messageId: string, expectedHeadId: string) => Promise<void>;
  forkingMessageId?: string;
  focusMessageId?: string;
}) {
  const { t } = useUiTranslation('chat');
  const { t: tWorkbench } = useUiTranslation('workbench');
  const { id, draft: serverDraft } = snapshot.session;
  const hasWorkspace = Boolean(snapshot.workspace);

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
  const { mutateAsync: sendSessionMessage } = useSendSessionMessage();
  const { mutateAsync: insertQueuedMessage } = useInsertQueuedMessage(id);
  const { mutateAsync: stopRunAsync } = useStopRun();
  const { mutateAsync: retryRunAsync } = useRetryRun();
  const forkSession = useForkSession();
  const { mutateAsync: forkSessionAsync } = forkSession;
  const retryKeys = useRef(new Map<string, string>());
  const forkKeys = useRef(new Map<string, string>());
  const forking = useRef(false);

  const getDraft = useCallback(() => readDraft(id, serverDraft), [id, serverDraft]);
  const fallback = useMemo(getDraft, [getDraft]);
  const nativeAvailable = isNativeAvailable(snapshot, nativeExecution);
  const readonlyProfile = snapshot.agent?.mode === 'readonly';

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

  const handleModelChange = useCallback(
    (model?: string) => {
      if (store.getState().workspace.submitting[id]) return;
      changeDraft(
        (previous) => ({
          ...previous,
          model,
          effort: previous.model === model ? previous.effort : undefined,
        }),
        true,
      );
    },
    [changeDraft, id],
  );

  const handleEffortChange = useCallback(
    (effort?: ReasoningEffort) => {
      if (store.getState().workspace.submitting[id]) return;
      changeDraft((previous) => ({ ...previous, effort }), true);
    },
    [changeDraft, id],
  );

  const changeMode = useCallback(
    (mode: ComposerMode) => {
      if (store.getState().workspace.submitting[id]) return;
      if (readonlyProfile && mode !== 'readonly') return;
      if (mode === 'native' && !nativeAvailable) return;
      if (mode !== 'automatic') store.dispatch(actions.setSearchChargeLimit({ id }));
      updateDraft(id, (previous) => withComposerMode(previous, mode), serverDraft, true);
    },
    [id, nativeAvailable, readonlyProfile, serverDraft],
  );

  const send = useCallback(
    async (insertIntoRunId?: string) => {
      let result;
      try {
        result = await submitDraft(
          id,
          serverDraft,
          sendSessionMessage,
          readonlyProfile,
          defaultModel || undefined,
          nativeAvailable,
        );
      } catch (error) {
        if (hasWorkspace) void onSent(id).catch(() => {});
        onError(translateError(error, t('session.sendUnconfirmed')));
        return;
      }
      if (!result) return;
      if (insertIntoRunId && result.queuedMessage?.insertion === 'priority') {
        onError(t('session.insertRequiresStop'));
      } else if (insertIntoRunId && result.queuedMessage?.insertion === 'live') {
        try {
          await insertQueuedMessage({
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
    },
    [
      defaultModel,
      hasWorkspace,
      id,
      insertQueuedMessage,
      nativeAvailable,
      onError,
      onSent,
      readonlyProfile,
      sendSessionMessage,
      serverDraft,
      t,
    ],
  );

  const handleStop = useCallback(
    (runId: string) => {
      if (onStop) {
        onStop(runId);
        return;
      }
      void stopRunAsync({ id: runId, sessionId: id }).catch((error: unknown) => {
        onError(translateError(error, tWorkbench('session.actionFailed')));
      });
    },
    [id, onError, onStop, stopRunAsync, tWorkbench],
  );

  const handleRetry = useCallback(
    (runId: string) => {
      if (onRetry) {
        onRetry(runId);
        return;
      }
      const idempotencyKey = retryKeys.current.get(runId) ?? crypto.randomUUID();
      retryKeys.current.set(runId, idempotencyKey);
      void retryRunAsync({ id: runId, sessionId: id, idempotencyKey }).then(
        () => {
          if (retryKeys.current.get(runId) === idempotencyKey) retryKeys.current.delete(runId);
        },
        (error: unknown) => {
          onError(translateError(error, tWorkbench('session.actionFailed')));
        },
      );
    },
    [id, onError, onRetry, retryRunAsync, tWorkbench],
  );

  const continueFromMessage = useCallback(
    async (messageId: string, rewindFromHead?: string) => {
      if (forking.current) throw new Error(tWorkbench('session.actionBusy'));
      const sourcePath = getLocationPath?.();
      const key = JSON.stringify([id, messageId, rewindFromHead]);
      const idempotencyKey = forkKeys.current.get(key) ?? crypto.randomUUID();
      forkKeys.current.set(key, idempotencyKey);
      forking.current = true;
      try {
        const { session: child } = await forkSessionAsync({
          sessionId: id,
          messageId,
          idempotencyKey,
          rewindFromHead,
        });
        forkKeys.current.delete(key);
        if (!sourcePath || getLocationPath?.() === sourcePath) {
          onOpenSession?.(child.id);
        } else {
          onError(
            rewindFromHead
              ? tWorkbench('session.rewindCreated', { title: child.title })
              : tWorkbench('session.branchCreated', { title: child.title }),
          );
        }
      } finally {
        forking.current = false;
      }
    },
    [forkSessionAsync, getLocationPath, id, onError, onOpenSession, tWorkbench],
  );

  const handleForkMessage = useCallback(
    (messageId: string) => {
      if (onForkMessage) {
        onForkMessage(messageId);
        return;
      }
      void continueFromMessage(messageId).catch((error: unknown) => {
        onError(translateError(error, tWorkbench('session.createBranchFailed')));
      });
    },
    [continueFromMessage, onError, onForkMessage, tWorkbench],
  );

  const handleRewindMessage = useCallback(
    (messageId: string, expectedHeadId: string) => {
      if (onRewindMessage) return onRewindMessage(messageId, expectedHeadId);
      return continueFromMessage(messageId, expectedHeadId);
    },
    [continueFromMessage, onRewindMessage],
  );

  const activeForkingMessageId =
    forkingMessageId ??
    (forkSession.isPending &&
    !forkSession.variables?.rewindFromHead &&
    forkSession.variables?.sessionId === id
      ? forkSession.variables.messageId
      : undefined);

  return (
    <Chat
      snapshot={snapshot}
      draft={savedDraft ?? fallback}
      getDraft={getDraft}
      defaultModel={defaultModel}
      nativeExecution={nativeExecution}
      onOpenLink={onOpenLink}
      onModelChange={handleModelChange}
      onEffortChange={handleEffortChange}
      onModeChange={changeMode}
      onDraftChange={changeDraft}
      onSend={send}
      onStop={handleStop}
      onRetry={handleRetry}
      onTrace={onTrace}
      onOpenSchedule={onOpenSchedule}
      onForkMessage={handleForkMessage}
      onRewindMessage={handleRewindMessage}
      forkingMessageId={activeForkingMessageId}
      submitting={submitting}
    />
  );
}
