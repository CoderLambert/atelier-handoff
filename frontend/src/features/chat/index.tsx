import type { Draft } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { Composer, type DraftChange } from './composer';
import { Conversation } from './conversation';
import type { AutomaticApprovalSelection, ComposerMode } from './run-mode';
import './chat.css';

export interface ChatProps {
  snapshot: Snapshot;
  draft: Draft;
  automaticApproval?: AutomaticApprovalSelection;
  onModeChange: (mode: ComposerMode) => void;
  onSearchChargeChange: (value: string) => void;
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
        automaticApproval={props.automaticApproval}
        onModeChange={props.onModeChange}
        onSearchChargeChange={props.onSearchChargeChange}
        onDraftChange={props.onDraftChange}
        onSend={props.onSend}
        onStop={props.onStop}
        submitting={submitting}
      />
    </>
  );
}
