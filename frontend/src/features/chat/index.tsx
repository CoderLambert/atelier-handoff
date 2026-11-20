/**
 * @file 组合会话消息和任务输入界面。
 * @implementation 将会话快照、持久草稿、模型与推理深度选择、临时搜索上限及运行操作传给消息区和输入区。
 * @updated 2026-11-20T17:14:57+08:00
 */
import type { Draft, ReasoningEffort } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { Composer, type DraftChange } from './composer';
import { Conversation } from './conversation';
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
