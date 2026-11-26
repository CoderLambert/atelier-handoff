/**
 * @file 计算一条消息获接收后的会话草稿更新。
 * @implementation 仅清理提交时仍匹配的草稿，保留原执行偏好、模型和适用的 Skill 选择。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { formatMessageText } from '../../../shared/message-quotes.js';
import {
  emptyDraft,
  now,
  retainedSkillSelections,
  type Session,
  type UsedExtension,
} from '../../../shared/types.js';
import type { SessionMessageInput } from './message-input.js';

export function acceptedMessageChanges(
  latest: Session,
  original: Session,
  request: SessionMessageInput,
  executor: NonNullable<SessionMessageInput['executionPreference']>,
  retryOf: string | null,
  used?: UsedExtension[],
): Partial<Session> {
  const draftText = formatMessageText(latest.draft.text, latest.draft.messageQuotes).trim();
  return {
    title: latest.title === '新会话' ? request.text.slice(0, 40) : latest.title,
    updatedAt: now(),
    ...(JSON.stringify(latest.draft) === JSON.stringify(original.draft) &&
    (!draftText || draftText === request.text)
      ? {
          draft: {
            ...emptyDraft(),
            mode:
              request.executionPreference && !retryOf
                ? request.mode
                : retryOf || request.approvalMode || latest.draft.approvalMode
                  ? latest.draft.mode
                  : request.mode,
            ...((retryOf ? latest.draft.executionPreference : request.executionPreference)
              ? { executionPreference: retryOf ? latest.draft.executionPreference : executor }
              : {}),
            ...(request.executionPreference && !retryOf
              ? { approvalMode: request.approvalMode }
              : latest.draft.approvalMode
                ? { approvalMode: latest.draft.approvalMode }
                : {}),
            ...(latest.draft.model ? { model: latest.draft.model } : {}),
            ...(latest.draft.effort ? { effort: latest.draft.effort } : {}),
            extensionSelections: retryOf
              ? latest.draft.extensionSelections
              : retainedSkillSelections(used),
          },
        }
      : {}),
  };
}
