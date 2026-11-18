import type { Draft } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { Composer, type DraftChange } from './composer';
import { Conversation } from './conversation';
import './chat.css';

export interface ChatProps {
  snapshot: Snapshot;
  draft: Draft;
  onDraftChange: DraftChange;
  onSend: () => Promise<void>;
  onStop: (runId: string) => void;
  onRetry: (runId: string) => void;
  onTrace: (runId: string) => void;
  submitting: boolean;
}

export default function Chat(props: ChatProps) {
  const { snapshot, onRetry, onTrace, submitting } = props;
  return (
    <>
      <Conversation
        key={`conversation:${snapshot.session.id}`}
        snapshot={snapshot}
        onRetry={onRetry}
        onTrace={onTrace}
        submitting={submitting}
      />
      <Composer
        key={`composer:${snapshot.session.id}`}
        snapshot={snapshot}
        draft={props.draft}
        onDraftChange={props.onDraftChange}
        onSend={props.onSend}
        onStop={props.onStop}
        submitting={submitting}
      />
    </>
  );
}
