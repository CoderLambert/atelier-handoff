import { useCallback, useMemo } from 'react';
import type { Draft } from '@shared/types';
import type { Snapshot } from '@/api/types';
import Chat from '@/features/chat';
import { readDraft, submitDraft, updateDraft } from './drafts';
import { useWorkspace } from './store';

export default function SessionChat({
  snapshot,
  onSent,
  onError,
  onTrace,
  onStop,
  onRetry,
}: {
  snapshot: Snapshot;
  onSent: (id: string) => Promise<void>;
  onError: (message: string) => void;
  onTrace: (id: string) => void;
  onStop: (runId: string) => void;
  onRetry: (runId: string) => void;
}) {
  const { id, draft: serverDraft } = snapshot.session;
  const savedDraft = useWorkspace((state) => state.workspace.drafts[id]);
  const submitting = useWorkspace((state) => state.workspace.submitting[id] === true);
  const fallback = useMemo(() => readDraft(id, serverDraft), [id, serverDraft]);
  const changeDraft = useCallback(
    (next: Draft | ((previous: Draft) => Draft)) => {
      updateDraft(id, next, serverDraft);
    },
    [id, serverDraft],
  );
  async function send() {
    try {
      await submitDraft(id, serverDraft);
      await onSent(id);
    } catch (error) {
      onError(`发送未确认，草稿已保留。${(error as Error).message}`);
    }
  }
  return (
    <Chat
      snapshot={snapshot}
      draft={savedDraft ?? fallback}
      onDraftChange={changeDraft}
      onSend={send}
      onStop={onStop}
      onRetry={onRetry}
      onTrace={onTrace}
      submitting={submitting}
    />
  );
}
