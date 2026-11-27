/**
 * @file 派生输入区和队列的使用条件，校验草稿引用。
 * @implementation 从会话快照推导目录、模式及插话目标，按引用来源去重并用发送正文的实际长度校验追加。
 * @updated 2026-11-27T18:34:46+08:00
 */
import type { Snapshot } from '@/api/types';
import {
  composerTextLimit,
  formatMessageText,
  messageQuoteLimit,
  messageQuotesSchema,
  type MessageQuote,
} from '@shared/message-quotes';
import { activeStatuses, type AgentSessionInfo, type Draft, type Run } from '@shared/types';
import { composerMode } from './run-mode';

type NativeScope = {
  agent?: Pick<AgentSessionInfo, 'mode'>;
  session: Pick<Snapshot['session'], 'id' | 'agentRevisionId'>;
};
type DirectoryScope = {
  workspace?: Pick<NonNullable<Snapshot['workspace']>, 'state'>;
  project: Pick<Snapshot['project'], 'available'>;
};
type ComposerRun = Pick<Run, 'id' | 'sessionId' | 'status'>;
type ComposerSnapshot<T extends ComposerRun> = NativeScope &
  DirectoryScope & {
    agent?: {
      mode: AgentSessionInfo['mode'];
      capabilities: ReadonlyArray<AgentSessionInfo['capabilities'][number]>;
    };
    session: Pick<Snapshot['session'], 'agentRevisionId' | 'id' | 'status'>;
    runs: readonly T[];
    messageQueue?: { items: readonly unknown[]; paused: boolean };
  };

export function isNativeAvailable({ agent, session }: NativeScope, nativeExecution: boolean) {
  return nativeExecution && !agent && !session.agentRevisionId;
}

export function isDirectoryAvailable({ workspace, project }: DirectoryScope) {
  return workspace ? workspace.state === 'ready' : project.available;
}

export function findActiveRun<T extends Pick<Run, 'status'>>(
  runs: readonly T[],
  { includeQueued = true } = {},
) {
  return runs.find(
    ({ status }) => activeStatuses.includes(status) && (includeQueued || status !== 'queued'),
  );
}

export function findInsertableRunId(run: ComposerRun | undefined, sessionId: string) {
  return run?.sessionId === sessionId &&
    (run.status === 'running' || run.status === 'awaiting_permission')
    ? run.id
    : undefined;
}

export function selectComposerPolicy<T extends ComposerRun>(
  snapshot: ComposerSnapshot<T>,
  draft: Draft,
  nativeExecution = false,
) {
  const { agent, session, runs, messageQueue } = snapshot;
  const archived = session.status === 'archived';
  const nativeAvailable = isNativeAvailable(snapshot, nativeExecution);
  const readonlyProfile = agent?.mode === 'readonly';
  const run = findActiveRun(runs);
  const hasQueuedMessages = Boolean(messageQueue?.items.length);
  return {
    archived,
    nativeAvailable,
    readonlyProfile,
    mode: composerMode(draft, readonlyProfile, nativeAvailable),
    contextAllowed: !agent || agent.capabilities.includes('context'),
    attachmentsAllowed: !agent || agent.capabilities.includes('attachments'),
    directoryAvailable: isDirectoryAvailable(snapshot),
    run,
    hasQueuedMessages,
    queueing: Boolean(run || hasQueuedMessages || messageQueue?.paused),
    insertRunId: archived ? undefined : findInsertableRunId(run, session.id),
  };
}

type AppendQuoteResult =
  | { status: 'added'; messageQuotes: MessageQuote[] }
  | { status: 'duplicate' | 'limit' | 'tooLong' };

export function appendDraftQuote(
  draft: Pick<Draft, 'text' | 'messageQuotes'>,
  quote: MessageQuote,
): AppendQuoteResult {
  const existing = draft.messageQuotes ?? [];
  const duplicate = existing.some((item) => {
    if (quote.file)
      return item.text === quote.text && JSON.stringify(item.file) === JSON.stringify(quote.file);
    if (quote.sourceMessageId !== undefined)
      return item.sourceMessageId === quote.sourceMessageId && item.text === quote.text;
    return item.id === quote.id;
  });
  if (duplicate) return { status: 'duplicate' };
  if (existing.length >= messageQuoteLimit) return { status: 'limit' };
  const messageQuotes = [...existing, quote];
  if (
    formatMessageText(draft.text, messageQuotes).length > composerTextLimit ||
    (quote.file && !messageQuotesSchema.safeParse(messageQuotes).success)
  )
    return { status: 'tooLong' };
  return { status: 'added', messageQuotes };
}
