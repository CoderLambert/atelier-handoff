/**
 * @file 组合会话消息和任务输入界面。
 * @implementation 组合消息区、按会话隔离的待处理队列和输入区，传递持久草稿、运行偏好、单次搜索上限与语义动作。
 * @updated 2026-11-20T23:09:03+08:00
 */
import type { Draft, ReasoningEffort } from '@shared/types';
import type { Snapshot } from '@/api/types';
import type { ChatLinkOpener } from './chat-web-link-dialog';
import { Composer, type DraftChange } from './composer';
import { Conversation } from './conversation';
import { MessageQueue } from './message-queue';
import type { ComposerMode } from './run-mode';
import './chat.css';

export interface ChatProps {
  snapshot: Snapshot;
  draft: Draft;
  searchChargeLimit?: string;
  defaultModel: string;
  onModelChange: (model?: string) => void;
  onEffortChange: (effort?: ReasoningEffort) => void;
  onModeChange: (mode: ComposerMode) => void;
  onSearchChargeChange: (value: string) => void;
  onDraftChange: DraftChange;
  onSend: () => Promise<void>;
  onStop: (runId: string) => void;
  onRetry: (runId: string) => void;
  onTrace: (runId: string) => void;
  onOpenLink?: ChatLinkOpener;
  submitting: boolean;
}

export default function Chat(props: ChatProps) {
  const { snapshot, onRetry, onTrace, onOpenLink, submitting } = props;
  return (
    <>
      <Conversation
        key={`conversation:${snapshot.session.id}`}
        snapshot={snapshot}
        onRetry={onRetry}
        onTrace={onTrace}
        onOpenLink={onOpenLink}
        submitting={submitting}
      />
      {snapshot.messageQueue ? (
        <MessageQueue
          key={`queue:${snapshot.session.id}`}
          sessionId={snapshot.session.id}
          queue={snapshot.messageQueue}
          archived={snapshot.session.status === 'archived'}
          available={snapshot.project.available}
        />
      ) : null}
      <Composer
        key={`composer:${snapshot.session.id}`}
        snapshot={snapshot}
        draft={props.draft}
        searchChargeLimit={props.searchChargeLimit}
        defaultModel={props.defaultModel}
        onModelChange={props.onModelChange}
        onEffortChange={props.onEffortChange}
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
