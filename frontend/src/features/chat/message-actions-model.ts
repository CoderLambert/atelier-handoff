/**
 * @file 消息动作状态计算与分支回溯判定模型。
 * @implementation 计算消息的分支锚点有效性、快照状态下的回溯禁用原因及复制反馈状态。
 * @updated 2026-11-23T18:25:00+08:00
 */
import { getTranslator } from '@/i18n';
import type { Snapshot } from '@/api/types';
import { activeStatuses, type Message } from '@shared/types';

export type MessageDraftAction = (message: Message, trigger: HTMLButtonElement) => void;

export type CopyFeedback = { status: 'pending' | 'copied' | 'error'; text: string };

export function hasMessageForkAnchor(message: Message): boolean {
  return Boolean(message.forkAnchor?.sdkSessionId.trim() && message.forkAnchor.messageId.trim());
}

export function rewindUnavailableReason(
  snapshot: Snapshot,
  submitting: boolean,
): string | undefined {
  const t = getTranslator('chat');
  if (submitting) return t('rewind.submitting');
  if (snapshot.session.status === 'archived') return t('rewind.archived');
  if (!snapshot.project.available) return t('rewind.projectUnavailable');
  if (snapshot.permissions.some((permission) => permission.status === 'pending'))
    return t('rewind.pendingApproval');
  if (snapshot.runs.some((run) => activeStatuses.includes(run.status)))
    return t('rewind.activeRun');
  if (!snapshot.messageQueue) return t('rewind.queueUnconfirmed');
  if (snapshot.messageQueue.items.some((item) => item.delivery === 'unknown'))
    return t('rewind.deliveryUnknown');
  if (snapshot.messageQueue.items.length) return t('rewind.queueNotEmpty');
  return undefined;
}
